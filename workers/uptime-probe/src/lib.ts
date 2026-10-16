// Pure logic of the uptime probe (tested in Node): probe verdicts, state transitions, the signed
// alert relay and the Resend e-mail call. No Workers runtime import or type here: the root
// tsconfig excludes workers/, so this file must also compile with the app's types (tests/unit).

export type Severity = "P0" | "P1" | "P2" | "info";
export type Status = "up" | "degraded" | "down";

export interface Target {
  name: string;
  url: string;
  /** Behind Cloudflare Access: send the service token headers. */
  access?: boolean;
}

export interface Alert {
  severity: Severity;
  title: string;
  body: string;
  env?: string;
}

export interface ProbeState {
  status: Status;
  /** Consecutive probes that disagree with `status`. */
  pending: number;
  since: number;
}

/** The KV subset used here (structurally matches the Workers KVNamespace binding). */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Probes that must agree before a change is announced (5-minute cron: about 10 minutes). */
export const CONFIRMATIONS = 2;
/** "Up" probes that must agree before a recovery is announced (about 15 minutes): a flapping target rings once. */
export const RECOVERY_CONFIRMATIONS = 3;
/** Signed relay requests older than this are refused (replay window). */
export const MAX_SKEW_SECONDS = 300;
/** Relayed app alerts e-mailed per UTC day: a flood must not spend the site's shared Resend quota (100/day). */
export const RELAY_DAILY_CAP = 20;
/** Probe (cron) alerts e-mailed per UTC day: a flapping target must not spend it either. Telegram stays uncapped. */
export const PROBE_DAILY_CAP = 10;
export const RESEND_URL = "https://api.resend.com/emails";
/** Resend refuses requests without a User-Agent (403, Cloudflare error 1010); workerd sets none. */
const RESEND_USER_AGENT = "joutiya-uptime-probe";
/** Daily KV markers outlive their day by one, then expire. */
const DAY_MARKER_TTL_SECONDS = 2 * 86_400;

export function parseTargets(raw: string | undefined): Target[] {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is Target =>
        typeof item === "object" && item !== null && typeof item.name === "string" && typeof item.url === "string" && item.url.startsWith("https://"),
    );
  } catch {
    return [];
  }
}

/** Verdict from /api/health: 200 "ok" is up, 503 "degraded" is degraded, anything else is down. */
export async function verdict(response: Response | null): Promise<{ status: Status; detail: string }> {
  if (!response) return { status: "down", detail: "pas de réponse (délai dépassé ou erreur réseau)" };
  let body: { status?: unknown } = {};
  try {
    body = (await response.json()) as { status?: unknown };
  } catch {
    // Not JSON: Cloudflare error page, Access login page...
  }
  if (response.status === 200 && body.status === "ok") return { status: "up", detail: "HTTP 200" };
  if (response.status === 503 && body.status === "degraded") return { status: "degraded", detail: "HTTP 503, dépendance en échec" };
  return { status: "down", detail: `HTTP ${response.status}` };
}

/** Next state, and the alert to send when a change is confirmed. */
export function transition(
  previous: ProbeState | null,
  observed: Status,
  now: number,
  target: string,
  detail: string,
): { state: ProbeState; alert: Alert | null } {
  if (!previous) {
    const state: ProbeState = { status: observed, pending: 0, since: now };
    if (observed === "up") return { state, alert: null };
    return { state: { ...state, status: "up", pending: 1 }, alert: null };
  }
  if (observed === previous.status) return { state: { ...previous, pending: 0 }, alert: null };
  const pending = previous.pending + 1;
  // Hysteresis: a recovery needs more agreeing probes than an incident.
  const needed = observed === "up" ? RECOVERY_CONFIRMATIONS : CONFIRMATIONS;
  if (pending < needed) return { state: { ...previous, pending }, alert: null };

  const state: ProbeState = { status: observed, pending: 0, since: now };
  const minutes = Math.max(1, Math.round((now - previous.since) / 60_000));
  if (observed === "up") {
    return {
      state,
      alert: {
        severity: "info",
        title: `${target} : rétabli`,
        body: `Le site répond de nouveau (${RECOVERY_CONFIRMATIONS} sondes consécutives, incident d'environ ${minutes} min).`,
      },
    };
  }
  return {
    state,
    alert: {
      severity: observed === "down" ? "P0" : "P1",
      title: observed === "down" ? `${target} : hors ligne` : `${target} : fonctionnement dégradé`,
      body: `Sonde /api/health : ${detail}. Confirmé par ${CONFIRMATIONS} sondes consécutives.`,
    },
  };
}

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checks a relay request signed by the app (src/lib/alert/relay.ts). */
export async function verifySignature(secret: string, timestamp: string | null, signature: string | null, body: string, nowSeconds: number): Promise<boolean> {
  if (!secret || !timestamp || !signature || !/^\d{10}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  return constantTimeEqual(await sign(secret, timestamp, body), signature.toLowerCase());
}

export function parseAlert(body: string): Alert | null {
  try {
    const value = JSON.parse(body) as Partial<Alert>;
    if (!["P0", "P1", "P2", "info"].includes(String(value.severity))) return null;
    if (typeof value.title !== "string" || typeof value.body !== "string") return null;
    return {
      severity: value.severity as Severity,
      title: value.title.slice(0, 200),
      body: value.body.slice(0, 4000),
      env: typeof value.env === "string" ? value.env.slice(0, 20) : undefined,
    };
  } catch {
    return null;
  }
}

const ICON: Record<Severity, string> = { P0: "🚨", P1: "🔴", P2: "🟠", info: "ℹ️" };

export function alertText(alert: Alert): string {
  const prefix = alert.env && alert.env !== "prod" ? `[${alert.env}] ` : "";
  return `${ICON[alert.severity]} ${prefix}${alert.severity} · ${alert.title}\n\n${alert.body}`;
}

export interface EmailPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** Resend request body. The subject stays one line whatever the alert carries (title and env come from the sender). */
export function emailPayload(from: string, to: string, alert: Alert): EmailPayload {
  const prefix = alert.env && alert.env !== "prod" ? `[${alert.env}] ` : "";
  const subject = `Joutiya ${prefix}${alert.severity} · ${alert.title}`.replace(/[\r\n]+/g, " ");
  return { from, to, subject, text: alertText(alert) };
}

/**
 * Resend settings, or null when e-mail is off (both unset: the Worker exists before the app is
 * configured). Exactly one set is a configuration error.
 */
export function emailSettings(to: string | undefined, apiKey: string | undefined): { to: string; apiKey: string } | null {
  if (!to && !apiKey) return null;
  if (!to || !apiKey) throw new Error("e-mail alerts misconfigured: ALERT_EMAIL_TO and RESEND_API_KEY must both be set");
  return { to, apiKey };
}

export interface SendOptions {
  /** Retry once on 429 rate_limit_exceeded. Cron path only: the relay must answer within the app's timeout. */
  retryRateLimit?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Used-quota headers of the free plan (value format undocumented: logged, never parsed). */
export interface SendResult {
  dailyQuota: string | null;
  monthlyQuota: string | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resend's error name when the body carries a plain identifier; the body itself is never surfaced. */
async function errorName(response: Response): Promise<string | null> {
  try {
    const value = (await response.json()) as { name?: unknown };
    return typeof value.name === "string" && /^[a-z_]{1,48}$/.test(value.name) ? value.name : null;
  } catch {
    return null;
  }
}

async function failure(response: Response): Promise<Error> {
  const name = await errorName(response);
  return new Error(`resend: HTTP ${response.status}${name ? ` ${name}` : ""}`);
}

/** Resend's Retry-After, capped at 2 s (10 requests/s per team: the wait is short by nature). */
function retryDelayMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  return Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds : 2, 2) * 1000;
}

/**
 * POST https://api.resend.com/emails. Errors read `resend: HTTP <status> <name>` or
 * `resend: <error name>`: never the key, never the response body, never a fetch error message
 * (it may echo request headers). A 3xx is a failure (redirect: "manual").
 */
export async function sendViaResend(
  fetchImpl: typeof fetch,
  apiKey: string,
  payload: EmailPayload,
  idempotencyKey: string,
  timeoutMs: number,
  options: SendOptions = {},
): Promise<SendResult> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      "User-Agent": RESEND_USER_AGENT,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
    redirect: "manual",
  };
  const attempt = async (): Promise<Response> => {
    try {
      return await fetchImpl(RESEND_URL, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`resend: ${error instanceof Error ? error.name : "fetch failed"}`);
    }
  };

  let response = await attempt();
  if (response.status === 429) {
    const name = await errorName(response);
    // Quota errors (daily_quota_exceeded, monthly_quota_exceeded) are final until the reset.
    if (name !== "rate_limit_exceeded" || !options.retryRateLimit) throw new Error(`resend: HTTP 429${name ? ` ${name}` : ""}`);
    await (options.sleep ?? defaultSleep)(retryDelayMs(response.headers.get("retry-after")));
    response = await attempt();
  }
  if (!response.ok) throw await failure(response);
  await response.body?.cancel();
  return { dailyQuota: response.headers.get("x-resend-daily-quota"), monthlyQuota: response.headers.get("x-resend-monthly-quota") };
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** UTC hour, e.g. 2026-10-16T10. */
export function utcHour(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13);
}

/** True the first time `name` is seen on the current UTC day (one notice a day). */
export async function markOncePerDay(kv: KeyValue, name: string, nowMs: number): Promise<boolean> {
  const key = `${name}:${utcDay(nowMs)}`;
  if (await kv.get(key)) return false;
  await kv.put(key, "1", { expirationTtl: DAY_MARKER_TTL_SECONDS });
  return true;
}

/** The two e-mail counters, one KV key each per UTC day. */
export type DailyCounter = "relay" | "probe";
const DAILY_CAPS: Record<DailyCounter, number> = { relay: RELAY_DAILY_CAP, probe: PROBE_DAILY_CAP };

/** Takes one of today's e-mail slots of `counter`; false once its cap is reached. */
export async function takeDailySlot(kv: KeyValue, counter: DailyCounter, nowMs: number, cap = DAILY_CAPS[counter]): Promise<boolean> {
  const key = `${counter}-count:${utcDay(nowMs)}`;
  const used = Number((await kv.get(key)) ?? "0");
  if (used >= cap) return false;
  await kv.put(key, String(used + 1), { expirationTtl: DAY_MARKER_TTL_SECONDS });
  return true;
}

/**
 * Coarse Resend idempotency key of a relayed alert: one title per environment per UTC hour. A
 * repeat inside the hour reaches Resend with the same key, so one e-mail leaves (an identical
 * payload is collapsed, a different one is refused: isIdempotentDuplicate). The app dedupes finer.
 */
export async function relayIdempotencyKey(alert: Pick<Alert, "title" | "env">, nowMs: number): Promise<string> {
  return `relay/${await sha256Hex(`${alert.env ?? ""}\n${alert.title}`)}/${utcHour(nowMs)}`;
}

/** Resend refused the key: the same alert left inside this hour (or is leaving right now). */
export function isIdempotentDuplicate(error: unknown): boolean {
  return error instanceof Error && /^resend: HTTP 409 (invalid_idempotent_request|concurrent_idempotent_requests)$/.test(error.message);
}

export type RelayOutcome = "sent" | "duplicate" | "capped" | "off";

/** 204: sent, or already sent this hour. 429: today's cap. 503: e-mail not configured on the Worker. */
const OUTCOME_STATUS: Record<RelayOutcome, number> = { sent: 204, duplicate: 204, capped: 429, off: 503 };

export interface RelayDeps {
  /** ALERT_RELAY_SECRET; empty refuses every request. */
  secret: string;
  nowMs: number;
  maxBytes: number;
  /** E-mails the alert, or says why not (see RelayOutcome). Throws when sending fails. */
  send(alert: Alert, idempotencyKey: string): Promise<RelayOutcome>;
}

/** POST /alert, signed by the app (src/lib/alert/relay.ts): 204 sent, 429 capped, 502 send failed, 503 e-mail off. */
export async function relay(request: Request, deps: RelayDeps): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? "0") > deps.maxBytes) return new Response(null, { status: 413 });
  // Chunked bodies carry no Content-Length: the read itself is capped, before any signature work.
  const body = await readCapped(request.body, deps.maxBytes);
  if (body === null) return new Response(null, { status: 413 });
  const signature = request.headers.get("X-Joutiya-Signature");
  const valid = await verifySignature(deps.secret, request.headers.get("X-Joutiya-Timestamp"), signature, body, Math.floor(deps.nowMs / 1000));
  if (!valid || !signature) return new Response(null, { status: 401 });
  const alert = parseAlert(body);
  if (!alert) return new Response(null, { status: 400 });
  try {
    const outcome = await deps.send(alert, await relayIdempotencyKey(alert, deps.nowMs));
    return new Response(null, { status: OUTCOME_STATUS[outcome] });
  } catch (error) {
    console.error(`email: ${(error as Error).message}`);
    return new Response(null, { status: 502 });
  }
}

/** Text of `body`, or null as soon as it exceeds `max` bytes: an oversized body is never held in memory. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}
