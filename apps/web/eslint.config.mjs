import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // React 19's compiler-aware rules expose valuable modernization work in
  // this pre-compiler codebase. Report it during migration without making
  // the existing application unlintable.
  {
    rules: {
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
    },
  },
  // These legacy workflow screens mirror large, heterogeneous backend payloads
  // that do not yet have stable schemas. Keep the exception tightly scoped;
  // new and shared code remains subject to no-explicit-any.
  {
    files: [
      "app/jobs/new/page.tsx",
      "app/jobs/*/rankings/page.tsx",
      "app/jobs/*/report/page.tsx",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
