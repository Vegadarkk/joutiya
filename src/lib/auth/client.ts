import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { GoogleInput, GoogleResponse, SessionSummary } from "@/lib/contracts/auth";
import { AUTH_API } from "@/lib/contracts/endpoints";
import type { ErrorCode } from "@/lib/http/errors";
import { CSRF_COOKIE, CSRF_HEADER } from "@/lib/security/cookies";

export { safeNextPath } from "./next-path";

// Browser side of the authentication API (§6): same-origin JSON calls, the CSRF header on every
// mutation, typed errors the UI translates, and one shared cache of GET /api/auth/me so the
// header, the account pages and the forms agree on who is signed in.

/** Server codes, plus `network` when the request never reached the server and `aborted` for a cancelled upload. */
export type ApiErrorCode = ErrorCode | "network" | "aborted";

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

/** Headers of a same-origin mutation: the CSRF header rides along whenever the cookie is readable. */
function mutationHeaders(withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (withBody) headers["content-type"] = "application/json";
  const csrf = csrfToken();
  if (csrf) headers[CSRF_HEADER] = csrf;
  return headers;
}

/** POST a JSON body. */
export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", headers: mutationHeaders(true), body: JSON.stringify(body ?? {}) });
}

/** PATCH a JSON body (partial updates: draft autosave). */
export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", headers: mutationHeaders(true), body: JSON.stringify(body ?? {}) });
}

/** DELETE; a 204 answer resolves to undefined. */
export function apiDelete<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE", headers: mutationHeaders(false) });
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET", headers: { accept: "application/json" } });
}

/**
 * GET a file with the CSRF header (the personal data export asks for it: a link from another site
 * carries the session cookie, never the header). Resolves to the body and the server's file name.
 */
export async function apiDownload(path: string): Promise<{ blob: Blob; filename: string | null }> {
  let response: Response;
  try {
    response = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", headers: mutationHeaders(false) });
  } catch {
    throw new ApiError(0, "network");
  }
  if (!response.ok) throw await toError(response);
  const match = /filename="([^"\\/]+)"/.exec(response.headers.get("Content-Disposition") ?? "");
  return { blob: await response.blob(), filename: match?.[1] ?? null };
}

/** Upload progress: `fraction` in [0, 1] when the browser knows the total, plus the raw counts. */
export type UploadProgress = (fraction: number, loaded: number, total: number) => void;

/**
 * PUT a file to a presigned URL (R2, or the dev storage route). Cross-origin by design: no
 * cookie, no CSRF header, only the headers the signature covers (Content-Type). XMLHttpRequest
 * is the one browser API that reports upload progress; `signal` cancels the request.
 */
export function uploadToPresignedUrl(url: string, headers: Record<string, string>, blob: Blob, onProgress?: UploadProgress, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError(0, "aborted"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (!onProgress) return;
      const total = event.lengthComputable ? event.total : blob.size;
      onProgress(total > 0 ? Math.min(1, event.loaded / total) : 0, event.loaded, total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1, blob.size, blob.size);
        resolve();
      } else {
        reject(new ApiError(xhr.status, fallbackCode(xhr.status), { message: `upload failed (${xhr.status})` }));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network"));
    xhr.ontimeout = () => reject(new ApiError(0, "network", { message: "upload timed out" }));
    xhr.onabort = () => reject(new ApiError(0, "aborted"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/**
 * POST /api/auth/google: the Google Identity Services credential. The page gave GIS a nonce derived
 * from the device cookie; the server recomputes it from that cookie and matches the token's `nonce`
 * claim, so a token cannot be used from another device (nothing in this body attests it).
 */
export function googleSignIn(input: GoogleInput): Promise<GoogleResponse> {
  return apiPost<GoogleResponse>(AUTH_API.google, input);
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

/**
 * What the server already knows about the session when it rendered the page: the private layout
 * hands it to the providers (public pages are static and pass nothing). null = anonymous;
 * undefined = unknown, the browser asks /api/auth/me.
 */
export const InitialSessionContext = createContext<SessionSummary | null | undefined>(undefined);

/** Fills a store that has not asked the server yet; a later answer or sign-in wins over the seed. */
function seedSession(session: SessionSummary | null): void {
  if (state.status === "idle" && !inflight) emit({ status: "ready", session });
}

/**
 * The shared session state. With a server-provided initial session, the first render (server and
 * hydration alike) is already `ready`; otherwise the first subscriber triggers the fetch.
 */
export function useSession(): SessionState {
  const initial = useContext(InitialSessionContext);
  const snapshot = useSyncExternalStore(subscribeSession, sessionSnapshot, serverSnapshot);
  useEffect(() => {
    if (snapshot.status !== "idle") return;
    if (initial === undefined) void loadSession();
    else seedSession(initial);
  }, [snapshot.status, initial]);
  return snapshot.status === "idle" && initial !== undefined ? { status: "ready", session: initial } : snapshot;
}

/** POST /api/auth/logout, then forget the session locally whatever the server answered. */
export async function signOut(): Promise<void> {
  try {
    await apiPost<void>(AUTH_API.logout, {});
  } finally {
    setSession(null);
  }
}

