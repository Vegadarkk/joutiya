import { useEffect, useSyncExternalStore } from "react";
import { AUTH_API, type SessionSummary } from "@/lib/contracts/auth";
import type { ErrorCode } from "@/lib/http/errors";
import { CSRF_COOKIE, CSRF_HEADER } from "@/lib/security/cookies";

// Browser side of the authentication API (§6): same-origin JSON calls, the CSRF header on every
// mutation, typed errors the UI translates, and one shared cache of GET /api/auth/me so the
// header, the account pages and the forms agree on who is signed in.

/** Server codes, plus `network` when the request never reached the server. */
export type ApiErrorCode = ErrorCode | "network";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;
  /** Seconds to wait, from the Retry-After header (429, 503). */
  readonly retryAfter?: number;

  constructor(status: number, code: ApiErrorCode, options: { message?: string; details?: unknown; retryAfter?: number } = {}) {
    super(options.message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }
}

export function isApiError(error: unknown, ...codes: ApiErrorCode[]): error is ApiError {
  return error instanceof ApiError && (codes.length === 0 || codes.includes(error.code));
}

/** CSRF token of the last /me answer, for browsers that hide the cookie (none known; a fallback). */
let csrfFromHeader: string | undefined;

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function csrfToken(): string | undefined {
  return readCookie(CSRF_COOKIE) ?? csrfFromHeader;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

function fallbackCode(status: number): ApiErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return "internal";
}

async function toError(response: Response): Promise<ApiError> {
  let code = fallbackCode(response.status);
  let message: string | undefined;
  let details: unknown;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body?.error?.code) {
      code = body.error.code as ApiErrorCode;
      message = body.error.message;
      details = body.error.details;
    }
  } catch {
    // Not a JSON error body (proxy page, empty answer): keep the status-based code.
  }
  return new ApiError(response.status, code, { message, details, retryAfter: parseRetryAfter(response.headers.get("Retry-After")) });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    throw new ApiError(0, "network");
  }
  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** POST a JSON body. The CSRF header rides along whenever a session cookie is readable. */
export function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const csrf = csrfToken();
  if (csrf) headers[CSRF_HEADER] = csrf;
  return request<T>(path, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET", headers: { accept: "application/json" } });
}

// --- Session cache -------------------------------------------------------------------------

export interface SessionState {
  /** idle: never asked; loading: /me in flight; ready: the answer (null = anonymous). */
  status: "idle" | "loading" | "ready";
  session: SessionSummary | null;
}

const INITIAL: SessionState = { status: "idle", session: null };
let state: SessionState = INITIAL;
let inflight: Promise<SessionSummary | null> | undefined;
const listeners = new Set<() => void>();

function emit(next: SessionState): void {
  state = next;
  for (const listener of listeners) listener();
}

async function fetchMe(): Promise<SessionSummary | null> {
  try {
    const response = await fetch(AUTH_API.me, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
    // 401, 404 (route not deployed), 5xx: shown as anonymous rather than as an error.
    if (!response.ok) return null;
    csrfFromHeader = response.headers.get(CSRF_HEADER) ?? csrfFromHeader;
    const body = (await response.json()) as { session?: SessionSummary | null };
    return body.session ?? null;
  } catch {
    return null;
  }
}

/** Identity of the latest call: an older answer arriving after a newer call is dropped. */
let current: object | undefined;

function run(): Promise<SessionSummary | null> {
  const token = {};
  current = token;
  const promise = (async () => {
    emit({ status: "loading", session: state.session });
    const session = await fetchMe();
    if (current === token) {
      current = undefined;
      inflight = undefined;
      emit({ status: "ready", session });
    }
    return session;
  })();
  inflight = promise;
  return promise;
}

/** The current session, fetched once and shared; `refreshSession()` asks the server again. */
export function loadSession(): Promise<SessionSummary | null> {
  if (inflight) return inflight;
  if (state.status === "ready") return Promise.resolve(state.session);
  return run();
}

export function refreshSession(): Promise<SessionSummary | null> {
  return run();
}

/** Records a session returned by login, signup verification or a profile update (no round trip). */
export function setSession(session: SessionSummary | null): void {
  inflight = undefined;
  current = undefined;
  if (!session) csrfFromHeader = undefined;
  emit({ status: "ready", session });
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const sessionSnapshot = () => state;
const serverSnapshot = () => INITIAL;

/** The shared session state; the first subscriber triggers the fetch. */
export function useSession(): SessionState {
  const snapshot = useSyncExternalStore(subscribeSession, sessionSnapshot, serverSnapshot);
  useEffect(() => {
    if (snapshot.status === "idle") void loadSession();
  }, [snapshot.status]);
  return snapshot;
}

/** POST /api/auth/logout, then forget the session locally whatever the server answered. */
export async function signOut(): Promise<void> {
  try {
    await apiPost<void>(AUTH_API.logout, {});
  } finally {
    setSession(null);
  }
}

/**
 * A `?next=` target is followed only when it is a same-origin relative path: starts with one
 * slash, no scheme, no backslash (browsers turn `\` into `/`).
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}
