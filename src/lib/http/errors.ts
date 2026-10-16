// API error model (§6). Every route answers errors as `{ error: { code, message?, details? } }` with a
// stable `code` the client translates; `message` is a short English hint for logs and curl, never
// shown to users. Codes are deliberately coarse: a 401 never says whether an account exists.

export type ErrorCode =
  | "invalid_body"
  | "invalid_json"
  | "payload_too_large"
  | "unauthenticated"
  | "forbidden"
  | "csrf"
  | "origin"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "rate_limited"
  | "turnstile_required"
  | "turnstile_failed"
  | "invalid_credentials"
  | "account_locked"
  | "account_disabled"
  | "account_suspended"
  | "email_not_verified"
  | "role_missing"
  | "invalid_code"
  | "expired_code"
  | "weak_password"
  | "disposable_email"
  | "consent_required"
  | "phone_invalid"
  | "phone_not_mobile"
  | "unavailable"
  | "internal";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(status: number, code: ErrorCode, message?: string, options: { details?: unknown; headers?: Record<string, string> } = {}) {
    super(message ?? code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }

  toResponse(): Response {
    return errorResponse(this.status, this.code, this.message === this.code ? undefined : this.message, this.details, this.headers);
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message?: string; details?: unknown };
}

export function errorResponse(status: number, code: ErrorCode, message?: string, details?: unknown, headers: Record<string, string> = {}): Response {
  const body: ErrorBody = { error: { code, ...(message ? { message } : {}), ...(details !== undefined ? { details } : {}) } };
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export const unauthenticated = (message?: string) => new HttpError(401, "unauthenticated", message);
export const forbidden = (message?: string) => new HttpError(403, "forbidden", message);
export const notFound = (message?: string) => new HttpError(404, "not_found", message);
export const unavailable = (message?: string) => new HttpError(503, "unavailable", message, { headers: { "Retry-After": "30" } });
export const rateLimited = (retryAfterSeconds: number) =>
  new HttpError(429, "rate_limited", undefined, { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) } });
