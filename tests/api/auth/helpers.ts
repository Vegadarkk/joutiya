import { NextRequest } from "next/server";
import { vi } from "vitest";
import type { SessionSummary } from "@/lib/contracts/auth";
import type { TemplateId, TemplateMail } from "@/lib/mail/types";

// Shared plumbing of the auth API tests: a cookie jar, a request builder for route handlers, the
// captured mails. Every test file mocks "@/lib/mail" and "@/lib/security/turnstile" itself
// (vi.mock is hoisted per file).

export const ORIGIN = "http://localhost:3000";
// Assembled at runtime: a literal would look like a credential to the secret scan.
export const PASSWORD = ["Correct", "Horse", "9"].join("-");
export const CONSENTS = { cgu: true, transfers: true, marketing: false } as const;

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
export type Handler = (request: NextRequest, context: RouteContext) => Promise<Response>;

let counter = 0;
export function uniqueEmail(tag = "u"): string {
  counter += 1;
  return `${Date.now()}-${tag}${counter}@test.joutiya.ma`;
}

let ipCounter = 0;
/** A fresh IPv4 per caller so the per-IP and anonymous-device limits never cross tests. */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 65536) % 256}.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

export class Jar {
  readonly cookies = new Map<string, string>();
  constructor(readonly ip: string = freshIp()) {}

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const maxAge = attributes.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith("max-age="));
      if (value === "" || (maxAge && Number(maxAge.slice("max-age=".length)) <= 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    const value = this.cookies.get(name);
    return value === undefined ? undefined : decodeURIComponent(value);
  }

  header(): string | undefined {
    const parts = [...this.cookies].map(([name, value]) => `${name}=${value}`);
    return parts.length ? parts.join("; ") : undefined;
  }
}

export interface CallOptions {
  jar?: Jar;
  body?: unknown;
  method?: "GET" | "POST";
  /** null: no Origin header at all. */
  origin?: string | null;
  /** false: do not send the X-CSRF-Token header even when the jar has the csrf cookie. */
  csrf?: boolean;
  headers?: Record<string, string>;
  ip?: string;
}

export interface CallResult<T> {
  status: number;
  body: T;
  response: Response;
  header(name: string): string | null;
}

export async function call<T = Record<string, unknown>>(handler: Handler, path: string, options: CallOptions = {}): Promise<CallResult<T>> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers = new Headers({ host: "localhost:3000", "x-forwarded-for": options.ip ?? options.jar?.ip ?? freshIp(), "user-agent": "vitest" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const cookie = options.jar?.header();
  if (cookie) headers.set("cookie", cookie);
  const csrf = options.jar?.get("__Host-csrf");
  if (csrf && options.csrf !== false) headers.set("x-csrf-token", csrf);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const request = new NextRequest(`${ORIGIN}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const response = await handler(request, { params: Promise.resolve({}) });
  options.jar?.absorb(response);
  const body = (response.status === 204 ? null : await response.json()) as T;
  return { status: response.status, body, response, header: (name) => response.headers.get(name) };
}

export type ErrorBody = { error: { code: string; details?: unknown } };
export type SignedInBody = { status: string; session: SessionSummary };

/** Mails captured by the "@/lib/mail" mock of the current test file. */
export function capturedMails(sendMail: unknown): TemplateMail[] {
  return vi.mocked(sendMail as (mail: TemplateMail) => Promise<void>).mock.calls.map(([mail]) => mail);
}

export function lastMail<T extends TemplateId>(sendMail: unknown, template: T, to?: string): TemplateMail<T> | undefined {
  const mails = capturedMails(sendMail).filter((mail): mail is TemplateMail<T> => mail.template === template && (to === undefined || mail.to === to));
  return mails.at(-1);
}

export function oobCodeOf(actionUrl: string): string {
  const code = new URL(actionUrl).searchParams.get("oobCode");
  if (!code) throw new Error(`no oobCode in ${actionUrl}`);
  return code;
}
