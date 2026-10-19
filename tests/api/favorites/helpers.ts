import { NextRequest } from "next/server";
import { expect } from "vitest";
import { RATE_LIMITS } from "@/config/rate-limits";
import { consumeLimit, limitState } from "@/lib/rate-limit/limiter";
import { ORIGIN, type ErrorBody, type Member } from "../listings/helpers";

// Plumbing of the favorites, saved searches and alerts API tests (lot L5): a request builder with
// the dynamic segment passed explicitly (PUT included), and the limiter pre-spend of the listings
// limit tests. Members come from ../listings/helpers, index documents from ../search/search-helpers.

export { member, type ErrorBody, type Member } from "../listings/helpers";
export { doc, serve } from "../search/search-helpers";

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
export type Handler = (request: NextRequest, context: RouteContext) => Promise<Response>;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CallOptions {
  member?: Member;
  /** JSON body, or a raw string body with its own content type (RFC 8058 form post). */
  body?: unknown;
  rawBody?: { text: string; type: string };
  params?: Record<string, string>;
  /** null: no Origin header at all. */
  origin?: string | null;
  /** false: no X-CSRF-Token header even when the member has one. */
  csrf?: boolean;
  ip?: string;
}

export interface CallResult<T> {
  status: number;
  body: T;
  header(name: string): string | null;
}

export async function call<T = Record<string, unknown>>(handler: Handler, method: Method, path: string, options: CallOptions = {}): Promise<CallResult<T>> {
  const headers = new Headers({ host: "localhost:3000", "x-forwarded-for": options.ip ?? options.member?.jar.ip ?? "10.98.0.1", "user-agent": "vitest" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  let body: string | undefined;
  if (options.rawBody) {
    headers.set("content-type", options.rawBody.type);
    body = options.rawBody.text;
  } else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const cookie = options.member?.jar.header();
  if (cookie) headers.set("cookie", cookie);
  const csrf = options.member?.jar.get("__Host-csrf");
  if (csrf && options.csrf !== false) headers.set("x-csrf-token", csrf);
  const request = new NextRequest(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
  options.member?.jar.absorb(response);
  const parsed = (response.status === 204 ? null : await response.json()) as T;
  return { status: response.status, body: parsed, header: (name) => response.headers.get(name) };
}

/** Spends what is left of `id`'s budget for `key` but `keep` points. */
export async function spend(id: keyof typeof RATE_LIMITS, key: string, keep = 0): Promise<void> {
  const used = (await limitState(id, key))?.consumedPoints ?? 0;
  const points = RATE_LIMITS[id].points - used - keep;
  if (points > 0) expect((await consumeLimit(id, key, points)).ok).toBe(true);
}

export function expectError(result: CallResult<unknown>, status: number, code: string): void {
  expect([result.status, (result.body as ErrorBody | null)?.error.code]).toEqual([status, code]);
}
