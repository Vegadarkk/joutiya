import {
  alertText,
  emailPayload,
  emailSettings,
  isIdempotentDuplicate,
  markOncePerDay,
  parseTargets,
  PROBE_DAILY_CAP,
  relay,
  relayCap,
  sendViaResend,
  takeDailySlot,
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

type EmailSettings = NonNullable<ReturnType<typeof emailSettings>>;

/** E-mails the alert through Resend. Callers resolve the settings first (emailSettings: off while both secrets are unset). */
async function sendEmail(env: Env, settings: EmailSettings, alert: Alert, idempotencyKey: string, path: keyof typeof EMAIL_TIMEOUT_MS): Promise<void> {
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

/** One Telegram notice a day under `name` (Telegram is the channel that still works). Never throws. */
async function noticeOncePerDay(env: Env, name: string, now: number, alert: Alert): Promise<void> {
  try {
    if (await markOncePerDay(env.STATE, name, now)) await sendTelegram(env, alert);
  } catch (error) {
    console.error(String(error));
  }
}

/** Probe e-mail: off without settings, capped per UTC day (a flapping target must not spend the shared Resend quota). */
async function sendProbeEmail(env: Env, alert: Alert, idempotencyKey: string, now: number): Promise<void> {
  const settings = emailSettings(env.ALERT_EMAIL_TO, env.RESEND_API_KEY);
  if (!settings) {
    console.warn("e-mail alerts are off: ALERT_EMAIL_TO and RESEND_API_KEY are not set");
    return;
  }
  if (!(await takeDailySlot(env.STATE, "probe", now))) {
    console.warn("probe cap reached: alert e-mail skipped for today");
    await noticeOncePerDay(env, "probe-cap-notice", now, {
      severity: "P2",
      title: "e-mail d'alerte non envoyé",
      body: `Plafond quotidien des e-mails de sonde atteint (${PROBE_DAILY_CAP}). Les alertes de sonde ne partent que sur Telegram jusqu'à demain (UTC).`,
    });
    return;
  }
  await sendEmail(env, settings, alert, idempotencyKey, "cron");
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
  if (!previous || state.status !== previous.status || state.pending !== previous.pending || state.pendingStatus !== previous.pendingStatus) {
    await env.STATE.put(key, JSON.stringify(state));
  }
  if (!alert) return;
  // One transition, one e-mail: the key dedupes a re-run of the same transition for 24 h.
  const [telegram, email] = await Promise.allSettled([sendTelegram(env, alert), sendProbeEmail(env, alert, `probe/${target.name}/${state.since}`, now)]);
  if (telegram.status === "rejected") console.error(String(telegram.reason));
  if (email.status === "rejected") {
    const reason = String(email.reason);
    console.error(reason);
    // Quota spent: say so once a day on Telegram.
    if (/quota_exceeded/.test(reason)) {
      await noticeOncePerDay(env, "resend-quota-notice", now, {
        severity: "P2",
        title: "e-mail d'alerte non envoyé",
        body: `${reason}. Les alertes ne partent que sur Telegram jusqu'à la remise à zéro du quota Resend.`,
      });
    }
  }
}

/** Every target is checked; a check that throws (KV, JSON) is logged and noticed on Telegram once a day. */
async function runChecks(env: Env, targets: Target[], now: number): Promise<void> {
  const results = await Promise.allSettled(targets.map((target) => check(env, target, now)));
  const failed: string[] = [];
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const name = targets[index]?.name ?? "?";
    console.error(`probe ${name} failed: ${String(result.reason)}`);
    failed.push(name);
  });
  if (failed.length === 0) return;
  // Names only: an error message could echo a header or a URL. The detail is in the Worker logs.
  await noticeOncePerDay(env, "probe-error-notice", now, {
    severity: "P2",
    title: "sonde en erreur",
    body: `La vérification de ${failed.join(", ")} a échoué (détail dans les journaux du Worker). Un seul avis par jour.`,
  });
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
          // E-mail off: no slot is taken and the app learns it (503) instead of a silent 204.
          const settings = emailSettings(env.ALERT_EMAIL_TO, env.RESEND_API_KEY);
          if (!settings) return "off";
          if (!(await takeDailySlot(env.STATE, "relay", Date.now(), relayCap(alert.severity)))) {
            console.warn("relay cap reached: alert e-mail skipped for today");
            return "capped";
          }
          try {
            await sendEmail(env, settings, alert, idempotencyKey, "relay");
            return "sent";
          } catch (error) {
            // Same title inside the hour: the earlier e-mail stands (the slot stays spent, the cap counts attempts).
            if (isIdempotentDuplicate(error)) return "duplicate";
            throw error;
          }
        },
      });
    }
    return new Response(null, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runChecks(env, parseTargets(env.PROBE_TARGETS), controller.scheduledTime));
  },
};

export default worker;
