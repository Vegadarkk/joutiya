// Pure logic of the uptime probe (tested in Node): probe verdicts, state transitions, the signed
// alert relay and the MIME message. No Workers runtime import here.

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

/** Probes that must agree before a change is announced (5-minute cron: about 10 minutes). */
export const CONFIRMATIONS = 2;
/** Signed relay requests older than this are refused (replay window). */
export const MAX_SKEW_SECONDS = 300;

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
  if (pending < CONFIRMATIONS) return { state: { ...previous, pending }, alert: null };

  const state: ProbeState = { status: observed, pending: 0, since: now };
  const minutes = Math.max(1, Math.round((now - previous.since) / 60_000));
  if (observed === "up") {
    return { state, alert: { severity: "info", title: `${target} : rétabli`, body: `Le site répond de nouveau (incident d'environ ${minutes} min).` } };
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

function base64(text: string): string {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** RFC 5322 plain-text message. Header values are encoded, so alert text cannot inject headers. */
export function mime(from: string, to: string, alert: Alert, now: Date, id: string): string {
  const subject = `Joutiya ${alert.env && alert.env !== "prod" ? `[${alert.env}] ` : ""}${alert.severity} · ${alert.title}`;
  const domain = from.split("@")[1] ?? "joutiya.ma";
  const body = base64(alertText(alert)).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: Joutiya alertes <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${base64(subject)}?=`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
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
