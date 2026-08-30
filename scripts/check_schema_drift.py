#!/usr/bin/env python3
"""Fail when the code queries a table the schema never creates.

Why this exists: a discovery pass over this repo found 15 tables that application code
reads or writes but which no `CREATE TABLE` in the repository declares. Running the API
against a fresh database confirms it at runtime — `/api/v1/admin/analytics` and 17 other
endpoints return 500 with `relation "unipile_account_usage" does not exist`. The code and
the schema drifted apart, quietly, and nothing in CI noticed.

The check is deliberately narrow, because a noisy check gets switched off:

  * Only string literals that START with a SQL verb AND contain at least two distinct
    structural keywords count as SQL. Prose that happens to begin with "Update ..." does
    not — that alone was three false positives.
  * Docstrings are excluded outright.
  * CTE names (`WITH recent AS (...)`) are collected per FILE, because queries here are
    assembled from concatenated fragments and a CTE defined in one string is referenced
    in another.
  * `pg_*` and `information_schema.*` are system catalogs, not application tables.
  * Row-locking clauses are not tables: `FOR UPDATE SKIP LOCKED` parses as "UPDATE skip"
    to a naive regex.

Existing drift is recorded in scripts/schema_drift_baseline.txt so this can be adopted
without a 15-item red build. The check fails on anything NOT in that baseline — new drift
is blocked, and the backlog shrinks as entries are removed. It also fails when a baselined
table finally IS declared, so the file cannot rot.

Usage:  python scripts/check_schema_drift.py [--update-baseline]
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = Path(__file__).resolve().parent / "schema_drift_baseline.txt"
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", ".next", "build"}

_VERB = re.compile(r"^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b", re.I)
_STRUCT = re.compile(
    r"\b(FROM|INTO|SET|VALUES|WHERE|JOIN|RETURNING|ON\s+CONFLICT|GROUP\s+BY|ORDER\s+BY)\b", re.I)
_REF = re.compile(r"\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w.]*)", re.I)
_CREATE = re.compile(
    r"CREATE\s+(?:TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"']?"
    r"([A-Za-z_][\w.]*)", re.I)
_CTE = re.compile(r"([A-Za-z_]\w*)\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(", re.I)
_SYSTEM_PREFIXES = ("pg_", "information_schema.")
# Keywords a table-position regex picks up that are not tables. `skip`/`locked`/`nowait`
# come from `FOR UPDATE SKIP LOCKED`, which reads as "UPDATE skip".
_NOT_TABLES = {
    "set", "select", "values", "where", "on", "as", "only", "table", "using", "returning",
    "dual", "lateral", "unnest", "skip", "locked", "nowait", "share", "the", "a", "an",
}


def _docstring_ids(tree: ast.Module) -> set[int]:
    out: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", None)
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                out.add(id(body[0].value))
    return out


def scan() -> tuple[set[str], dict[str, str]]:
    """(tables the schema declares, table -> first place the code references it)."""
    declared: set[str] = set()
    referenced: dict[str, str] = {}
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in (".py", ".sql"):
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in _CREATE.finditer(text):
            declared.add(m.group(1).lower().split(".")[-1])
        if path.suffix == ".sql":
            continue
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        docs = _docstring_ids(tree)
        ctes = {c.lower() for c in _CTE.findall(text)}
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
                continue
            if id(node) in docs:
                continue
            raw = node.value.strip()
            if not _VERB.match(raw):
                continue
            kinds = {m.group(0).upper().split()[0] for m in _STRUCT.finditer(raw)}
            if len(kinds) < 2:            # prose that opens with a SQL verb
                continue
            for token in _REF.findall(raw):
                low = token.lower()
                if low.startswith(_SYSTEM_PREFIXES):
                    continue
                name = low.split(".")[-1]
                if name in _NOT_TABLES or name in ctes or len(name) <= 2:
                    continue
                referenced.setdefault(
                    name, f"{path.relative_to(ROOT)}:{getattr(node, 'lineno', '?')}")
    return declared, referenced


def load_baseline() -> set[str]:
    if not BASELINE.is_file():
        return set()
    return {line.strip().lower() for line in BASELINE.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")}


def main() -> int:
    declared, referenced = scan()
    missing = {t: where for t, where in sorted(referenced.items()) if t not in declared}

    if "--update-baseline" in sys.argv:
        BASELINE.write_text(
            "# Tables the code queries that no CREATE TABLE in this repo declares.\n"
            "# Each line is known drift, not an approval: the goal is an empty file.\n"
            "# Regenerate deliberately with: python scripts/check_schema_drift.py --update-baseline\n"
            + "".join(f"{t}\n" for t in sorted(missing)), encoding="utf-8")
        print(f"baseline written with {len(missing)} entries")
        return 0

    baseline = load_baseline()
    new_drift = {t: w for t, w in missing.items() if t not in baseline}
    fixed = sorted(baseline - set(missing))

    print(f"tables declared by CREATE TABLE : {len(declared)}")
    print(f"tables referenced by queries    : {len(referenced)}")
    print(f"referenced but never declared   : {len(missing)} ({len(baseline)} baselined)")

    if fixed:
        print("\nThese are now declared — remove them from the baseline:")
        for t in fixed:
            print(f"  - {t}")
    if new_drift:
        print("\nNEW schema drift — the code queries tables nothing creates:")
        for t, where in new_drift.items():
            print(f"  - {t:<28} first referenced at {where}")
        print("\nEither add the CREATE TABLE, or if the table belongs to another system,")
        print("add it to scripts/schema_drift_baseline.txt with a comment saying so.")
    if new_drift or fixed:
        return 1
    print("\nNo new schema drift.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
