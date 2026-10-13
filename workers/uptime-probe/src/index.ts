import { EmailMessage } from "cloudflare:email";
import { alertText, mime, parseAlert, parseTargets, transition, verdict, verifySignature, type Alert, type ProbeState, type Target } from "./lib";

// Uptime probe (cron, every 5 minutes) and e-mail relay for the app's alerts (POST /alert).
// Outside the VM on purpose: it still rings when the VM, the tunnel or Valkey is down.

interface Env {
  STATE: KVNamespace;
  EMAIL: SendEmail;
  PROBE_TARGETS: string;
  ALERT_EMAIL_FROM: string;
  ALERT_EMAIL_TO?: string;
  ALERT_RELAY_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}

const PROBE_TIMEOUT_MS = 10_000;
const MAX_ALERT_BYTES = 16_384;

async function sendEmail(env: Env, alert: Alert): Promise<void> {
  if (!env.ALERT_EMAIL_TO) return;
  const raw = mime(env.ALERT_EMAIL_FROM, env.ALERT_EMAIL_TO, alert, new Date(), crypto.randomUUID());
  await env.EMAIL.send(new EmailMessage(env.ALERT_EMAIL_FROM, env.ALERT_EMAIL_TO, raw));
}

async function sendTelegram(env: Env, alert: Alert): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: alertText(alert), disable_web_page_preview: true }),
  });
  // The token is in the URL: report the status only.
  if (!response.ok) throw new Error(`telegram: HTTP ${response.status}`);
}

async function probe(env: Env, target: Target): Promise<Response | null> {
  const headers: Record<string, string> = { "User-Agent": "joutiya-uptime-probe", "Cache-Control": "no-cache" };
  if (target.access && env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.ACCESS_CLIENT_SECRET;
  }
  try {
    return await fetch(target.url, { headers, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

async function check(env: Env, target: Target, now: number): Promise<void> {
  const { status, detail } = await verdict(await probe(env, target));
  const key = `probe:${target.name}`;
  const stored = await env.STATE.get(key);
  const previous = stored ? (JSON.parse(stored) as ProbeState) : null;
  const { state, alert } = transition(previous, status, now, target.name, detail);
  // KV writes only when something changed (free tier: 1,000 writes a day).
  if (!previous || state.status !== previous.status || state.pending !== previous.pending) {
    await env.STATE.put(key, JSON.stringify(state));
  }
  if (alert) {
    const results = await Promise.allSettled([sendTelegram(env, alert), sendEmail(env, alert)]);
    for (const result of results) if (result.status === "rejected") console.error(String(result.reason));
  }
}

async function relay(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_ALERT_BYTES) return new Response(null, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_ALERT_BYTES) return new Response(null, { status: 413 });
  const valid = await verifySignature(
    env.ALERT_RELAY_SECRET ?? "",
    request.headers.get("X-Joutiya-Timestamp"),
    request.headers.get("X-Joutiya-Signature"),
    body,
    Math.floor(Date.now() / 1000),
  );
  if (!valid) return new Response(null, { status: 401 });
  const alert = parseAlert(body);
  if (!alert) return new Response(null, { status: 400 });
  try {
    await sendEmail(env, alert);
  } catch (error) {
    console.error(`email: ${(error as Error).message}`);
    return new Response(null, { status: 502 });
  }
  return new Response(null, { status: 204 });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/alert" && request.method === "POST") return relay(request, env);
    return new Response(null, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const targets = parseTargets(env.PROBE_TARGETS);
    ctx.waitUntil(Promise.allSettled(targets.map((target) => check(env, target, controller.scheduledTime))));
  },
};

export default worker;
