import {
  alertText,
  emailPayload,
  emailSettings,
  markOncePerDay,
  parseTargets,
  relay,
  sendViaResend,
  takeRelaySlot,
  transition,
  verdict,
  type Alert,
  type ProbeState,
  type Target,
} from "./lib";

// Uptime probe (cron, every 5 minutes) and e-mail relay for the app's alerts (POST /alert).
// Outside the VM on purpose: it still rings when the VM, the tunnel or Valkey is down. E-mail
// goes through the Resend API with the Worker's own key (never on the VM); Telegram stays the
// first channel and the two are sent in parallel, so a Resend failure never blocks it.

interface Env {
  STATE: KVNamespace;
  PROBE_TARGETS: string;
  /** "Joutiya alertes <alertes@notif.joutiya.ma>" (wrangler.jsonc). */
  ALERT_EMAIL_FROM: string;
  ALERT_EMAIL_TO?: string;
  RESEND_API_KEY?: string;
  ALERT_RELAY_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}

const PROBE_TIMEOUT_MS = 10_000;
const MAX_ALERT_BYTES = 16_384;
/** Scheduled runs have 15 minutes of wall time; the relay must answer inside the app's 8 s timeout. */
const EMAIL_TIMEOUT_MS = { cron: 10_000, relay: 6_000 } as const;

/** E-mails the alert through Resend. Off (with a warning) while ALERT_EMAIL_TO and RESEND_API_KEY are both unset. */
async function sendEmail(env: Env, alert: Alert, idempotencyKey: string, path: keyof typeof EMAIL_TIMEOUT_MS): Promise<void> {
  const settings = emailSettings(env.ALERT_EMAIL_TO, env.RESEND_API_KEY);
  if (!settings) {
    console.warn("e-mail alerts are off: ALERT_EMAIL_TO and RESEND_API_KEY are not set");
    return;
  }
  const payload = emailPayload(env.ALERT_EMAIL_FROM, settings.to, alert);
  const { dailyQuota, monthlyQuota } = await sendViaResend(fetch, settings.apiKey, payload, idempotencyKey, EMAIL_TIMEOUT_MS[path], { retryRateLimit: path === "cron" });
  // Used-quota headers of the free plan (value format undocumented: read it in the logs of the live test).
  if (dailyQuota !== null || monthlyQuota !== null) console.log(`resend quota used: daily=${dailyQuota ?? "-"} monthly=${monthlyQuota ?? "-"}`);
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
  if (!alert) return;
  // One transition, one e-mail: the key dedupes a re-run of the same transition for 24 h.
  const [telegram, email] = await Promise.allSettled([sendTelegram(env, alert), sendEmail(env, alert, `probe/${target.name}/${state.since}`, "cron")]);
  if (telegram.status === "rejected") console.error(String(telegram.reason));
  if (email.status === "rejected") {
    const reason = String(email.reason);
    console.error(reason);
    // Quota spent: say so once a day on Telegram, the channel that still works.
    if (/quota_exceeded/.test(reason) && (await markOncePerDay(env.STATE, "resend-quota-notice", now))) {
      const notice: Alert = {
        severity: "P2",
        title: "e-mail d'alerte non envoyé",
        body: `${reason}. Les alertes ne partent que sur Telegram jusqu'à la remise à zéro du quota Resend.`,
      };
      await sendTelegram(env, notice).catch((error: unknown) => console.error(String(error)));
    }
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/alert" && request.method === "POST") {
      return relay(request, {
        secret: env.ALERT_RELAY_SECRET ?? "",
        nowMs: Date.now(),
        maxBytes: MAX_ALERT_BYTES,
        send: async (alert, idempotencyKey) => {
          if (!(await takeRelaySlot(env.STATE, Date.now()))) {
            console.warn("relay cap reached: alert e-mail skipped for today");
            return false;
          }
          await sendEmail(env, alert, idempotencyKey, "relay");
          return true;
        },
      });
    }
    return new Response(null, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const targets = parseTargets(env.PROBE_TARGETS);
    ctx.waitUntil(Promise.allSettled(targets.map((target) => check(env, target, controller.scheduledTime))));
  },
};

export default worker;
