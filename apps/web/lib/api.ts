// Central API client. Keeps the FastAPI base URL + JSON boilerplate in one
// place. Streaming and multipart calls pass `API_BASE` directly; the `req`
// helper handles the JSON case.

import { trackEvent } from "@/lib/analytics";
import { msalInstance } from "@/lib/msal-config";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL!;

export interface ApiResponse<T> {
  status?: string;
  success?: boolean;
  data?: T;
  message?: string;
}

export interface AuthMeResponse {
  role?: "admin" | "team_lead" | "recruiter";
  is_admin?: boolean;
  is_team_lead?: boolean;
  team_id?: string | null;
  team_name?: string | null;
}

export interface ActivityLogApiItem {
  id: number;
  phase: string;
  activity_type: string;
  activity_subtype?: string;
  status: string;
  details?: {
    questions_completed?: number;
    answer_count?: number;
    subject?: string;
    message_type?: string;
    old_phase?: string;
    new_phase?: string;
    launch_context?: string;
    session_started_at?: string;
    status?: string;
    message?: string;
    content?: string;
    phone_number?: string;
    error?: string;
  };
  timestamp: string;
}

declare global {
  interface Window {
    __apiFetchPatched?: boolean;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : stringProperty(error, "message") || fallback;
}

export function getActiveUserEmail(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const active = msalInstance.getActiveAccount();
    if (active?.username) return active.username;
    const all = msalInstance.getAllAccounts();
    if (all && all.length > 0 && all[0].username) {
      return all[0].username;
    }
  } catch {
    // ignore if MSAL not initialized yet
  }
  if (process.env.NODE_ENV !== "production") {
    try {
      return localStorage.getItem("dev_user_email") || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  if (typeof window === "undefined") return {};

  const headers: Record<string, string> = {};
  const userEmail = getActiveUserEmail();
  if (userEmail) {
    headers["X-User-Email"] = userEmail;
  }

  try {
    const activeAccount =
      msalInstance.getActiveAccount() || (msalInstance.getAllAccounts()[0] ?? null);
    if (activeAccount) {
      try {
        const tokenResponse = await msalInstance.acquireTokenSilent({
          scopes: ["User.Read"],
          account: activeAccount,
        });
        let token: string | undefined = tokenResponse?.idToken || tokenResponse?.accessToken;
        token ||= stringProperty(activeAccount, "idToken");
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }
      } catch (err: unknown) {
        const errMsg = strError(err);
        if (
          stringProperty(err, "name") === "InteractionRequiredAuthError" ||
          errMsg.includes("interaction_required") ||
          errMsg.includes("aadsts160021") ||
          errMsg.includes("login_required")
        ) {
          msalInstance.loginRedirect({ scopes: ["User.Read"] }).catch(() => {});
        }
      }
    }
  } catch {
    // ignore if MSAL not initialized
  }

  return headers;
}

function strError(e: unknown): string {
  return (
    stringProperty(e, "message") ||
    stringProperty(e, "errorCode") ||
    String(e || "")
  ).toLowerCase();
}

export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  const existingHeaders = (init.headers || {}) as Record<string, string>;
  return fetch(url, {
    ...init,
    headers: {
      ...authHeaders,
      ...existingHeaders,
    },
  });
}

// fetch() network failures surface as a TypeError in all major browsers
// (Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError when
// attempting to fetch resource"), and a dropped streaming-body read rejects
// the same way. Errors we throw ourselves (non-OK statuses, JSON parse
// failures) are regular Error instances, so this cleanly separates
// "connectivity problem — retryable" from "server said no".
export function isNetworkFetchError(e: unknown): boolean {
  return e instanceof TypeError;
}

if (typeof window !== "undefined" && !window.__apiFetchPatched) {
  window.__apiFetchPatched = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input: RequestInfo | URL, init: RequestInit = {}) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url && (url.startsWith(API_BASE) || url.includes(API_BASE))) {
      const authHeaders = await getAuthHeaders();
      const existingHeaders = (init.headers || {}) as Record<string, string>;
      init = {
        ...init,
        headers: {
          ...authHeaders,
          ...existingHeaders,
        },
      };
    }
    return originalFetch(input, init);
  };
}

type JsonInit = Omit<RequestInit, "body" | "headers"> & {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

async function req<T>(path: string, init: JsonInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;
  const method = (rest.method || "GET").toUpperCase();
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  let trackedError = false;

  try {
    const authHeaders = await getAuthHeaders();
    const res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...authHeaders,
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
    const durationMs = Math.round((ended - started) * 100) / 100;

    if (!res.ok) {
      if (res.status === 401 && typeof window !== "undefined") {
        const activeAccount =
          msalInstance.getActiveAccount() || (msalInstance.getAllAccounts()[0] ?? null);
        if (activeAccount) {
          msalInstance.loginRedirect({ scopes: ["User.Read"] }).catch(() => {});
        }
      }
      const text = await res.text().catch(() => "");
      trackedError = true;
      trackEvent("api_request_error", {
        path,
        method,
        status: res.status,
        duration_ms: durationMs,
      });
      throw new Error(`${res.status} ${path}${text ? `: ${text}` : ""}`);
    }

    trackEvent("api_request_success", {
      path,
      method,
      status: res.status,
      duration_ms: durationMs,
    });
    return res.json() as Promise<T>;
  } catch (error: unknown) {
    if (!trackedError) {
      const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
      const durationMs = Math.round((ended - started) * 100) / 100;
      trackEvent("api_request_exception", {
        path,
        method,
        duration_ms: durationMs,
        message: getErrorMessage(error, "unknown_error"),
      });
    }
    throw error;
  }
}

export const api = {
  jobs: {
    fetch: (body: { job_id: string }) =>
      req<unknown>(`/jobs/fetch`, { method: "POST", body }),
    save: (jobId: string, body: unknown) =>
      req<unknown>(`/jobs/${jobId}/save`, { method: "POST", body }),
    saveStep: (jobId: string, step: number, body: unknown) =>
      req<unknown>(`/jobs/${jobId}/save-step?step=${step}`, { method: "POST", body }),
    monitor: (jobId: string, body: unknown) =>
      req<unknown>(`/jobs/${jobId}/monitor`, { method: "POST", body }),
    publish: (jobId: string, body: unknown) =>
      req<unknown>(`/jobs/${jobId}/publish`, { method: "POST", body }),
    createExternal: (body: unknown) =>
      req<unknown>(`/jobs/external/create`, { method: "POST", body }),
    getDraft: (jobId: string) => req<unknown>(`/jobs/${jobId}/draft`),
    getMonitoredData: (jobId: string) => req<unknown>(`/jobs/${jobId}/monitored-data`),
    updateBasicInfo: (jobId: string, body: unknown) =>
      req<unknown>(`/jobs/${jobId}/basic-info`, { method: "PUT", body }),
  },
  candidates: {
    save: (body: unknown) =>
      req<unknown>(`/candidates/save`, { method: "POST", body }),
    getResume: (candidateId: string) =>
      req<unknown>(`/candidates/${candidateId}/resume`),
    analyze: (body: unknown) =>
      req<unknown>(`/candidates/analyze`, { method: "POST", body }),
    // Streaming endpoint — callers need the raw Response for a ReadableStream.
    searchStreamUrl: `${API_BASE}/candidates/search`,
  },
  manualCandidates: {
    add: (jobRef: string, body: unknown) =>
      req<unknown>(`/jobs/${jobRef}/manual-candidate`, { method: "POST", body }),
    // Multipart upload — callers pass FormData directly.
    bulkUploadUrl: (jobRef: string) => `${API_BASE}/jobs/${jobRef}/bulk-resumes`,
  },
  chat: {
    send: (body: unknown) => req<unknown>(`/chat`, { method: "POST", body }),
  },
  engagement: {
    getActivityLogs: (interviewId: string) =>
      req<ApiResponse<{ activities: ActivityLogApiItem[] }>>(
        `/api/v1/engagement/interviews/${interviewId}/activity-logs`,
      ),
    getInterviewEvaluation: (interviewId: string) =>
      req<unknown>(`/api/v1/engagement/interviews/${interviewId}/evaluation`),
    getInterviewScoreSummary: (interviewId: string) =>
      req<unknown>(`/api/v1/engagement/interviews/${interviewId}/score-summary`),
    getAssessmentData: (interviewId: string) =>
      req<unknown>(`/api/v1/engagement/assess/${interviewId}`),
  },
  auth: {
    getMe: () => req<AuthMeResponse>(`/api/v1/auth/me`),
  },
  adminAnalytics: {
    get: <T>(teamId?: string | null) =>
      req<ApiResponse<T>>(`/api/v1/admin/analytics${teamId ? `?team_id=${encodeURIComponent(teamId)}` : ""}`),
    linkedinAccounts: <T>() =>
      req<ApiResponse<{ accounts: T[] }>>(`/api/v1/admin/linkedin-accounts`),
  },
  launchReport: {
    // `date` is a calendar date in Eastern time (YYYY-MM-DD); omitting it asks
    // the backend for yesterday. Team leads are auto-scoped server-side, so
    // teamId is only meaningful for admins.
    get: <T>(date?: string | null, teamId?: string | null) => {
      const qs = new URLSearchParams();
      if (date) qs.set("date", date);
      if (teamId) qs.set("team_id", teamId);
      const suffix = qs.toString();
      return req<ApiResponse<T>>(`/api/v1/launch-report${suffix ? `?${suffix}` : ""}`);
    },
  },
  noContact: {
    // Read-only: the list is code-managed (core/sourcing_config.py); admins
    // can view it but edits happen through code for now.
    companies: () => req<{ companies: string[]; editable: boolean }>(`/api/v1/no-contact/companies`),
  },
  teams: {
    list: <T>() => req<ApiResponse<{ teams: T[] }>>(`/api/v1/teams`),
    create: (body: { name: string; lead_emails: string; member_emails: string }) =>
      req<ApiResponse<unknown>>(`/api/v1/teams`, { method: "POST", body }),
    update: (teamId: string, body: { name: string; lead_emails: string; member_emails: string }) =>
      req<ApiResponse<unknown>>(`/api/v1/teams/${encodeURIComponent(teamId)}`, { method: "PUT", body }),
    remove: (teamId: string) =>
      req<ApiResponse<unknown>>(`/api/v1/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" }),
  },
};
