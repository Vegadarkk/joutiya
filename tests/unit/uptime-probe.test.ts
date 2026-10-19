import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CONFIRMATIONS,
  PROBE_DAILY_CAP,
  RECOVERY_CONFIRMATIONS,
  RELAY_DAILY_CAP,
  RELAY_P0_RESERVE,
  RESEND_URL,
  emailPayload,
  emailSettings,
  isIdempotentDuplicate,
  markOncePerDay,
  parseAlert,
  parseTargets,
  readCapped,
  relay,
  relayCap,
  relayIdempotencyKey,
  sendViaResend,
  sign,
  takeDailySlot,
  transition,
  utcHour,
  verdict,
  verifySignature,
  type Alert,
  type KeyValue,
  type ProbeState,
  type RelayOutcome,
} from "../../workers/uptime-probe/src/lib";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

// Not shaped like a real Resend key (re_ + 32 chars): Gitleaks runs on this repository.
const KEY = "test-worker-key";
const FROM = "Joutiya alertes <alertes@notif.joutiya.ma>";
const ALERT: Alert = { severity: "P0", title: "production : hors ligne", body: "Sonde /api/health : HTTP 502.", env: "prod" };

type FetchCall = { url: string; init: RequestInit };

/** fetch stub recording every call and answering from the queue (last answer repeats). */
function fetchStub(...answers: (Response | Error)[]) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return answer ?? new Response(null, { status: 500 });
  });
  return { calls, fetchImpl: impl as unknown as typeof fetch };
}

function memoryKv(): KeyValue & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
  };
}

describe("verdict", () => {
  it("reads /api/health", async () => {
    expect((await verdict(json(200, { status: "ok" }))).status).toBe("up");
    expect((await verdict(json(503, { status: "degraded" }))).status).toBe("degraded");
    expect((await verdict(new Response("<html>login</html>", { status: 302 }))).status).toBe("down");
    expect((await verdict(json(200, { status: "degraded" }))).status).toBe("down");
    expect((await verdict(null)).status).toBe("down");
  });
});

describe("transition", () => {
  const up: ProbeState = { status: "up", pending: 0, since: 0 };

  it("waits for confirmation before alerting", () => {
    let state = up;
    for (let probe = 1; probe < CONFIRMATIONS; probe += 1) {
      const step = transition(state, "down", probe * 300_000, "production", "HTTP 502");
      expect(step.alert).toBeNull();
      state = step.state;
    }
    const confirmed = transition(state, "down", 600_000, "production", "HTTP 502");
    expect(confirmed.alert?.severity).toBe("P0");
    expect(confirmed.state).toEqual({ status: "down", pending: 0, since: 600_000 });
  });

  it("forgets a single failed probe", () => {
    const blip = transition(up, "down", 1, "production", "x").state;
    expect(transition(blip, "up", 2, "production", "x")).toEqual({ state: up, alert: null });
  });

  it("announces recovery with the incident length after RECOVERY_CONFIRMATIONS up probes", () => {
    expect(RECOVERY_CONFIRMATIONS).toBeGreaterThan(CONFIRMATIONS);
    let state: ProbeState = { status: "down", pending: 0, since: 0 };
    for (let probe = 1; probe < RECOVERY_CONFIRMATIONS; probe += 1) {
      const step = transition(state, "up", probe * 300_000, "production", "HTTP 200");
      expect(step.alert).toBeNull();
      expect(step.state).toEqual({ status: "down", pending: probe, pendingStatus: "up", since: 0 });
      state = step.state;
    }
    const { state: recovered, alert } = transition(state, "up", 20 * 60_000, "production", "HTTP 200");
    expect(recovered).toEqual({ status: "up", pending: 0, since: 20 * 60_000 });
    expect(alert?.severity).toBe("info");
    expect(alert?.body).toContain("20 min");
  });

  it("stays silent while a site flaps between down and up", () => {
    const down: ProbeState = { status: "down", pending: 0, since: 0 };
    const once = transition(down, "up", 1, "production", "HTTP 200").state;
    const twice = transition(once, "up", 2, "production", "HTTP 200").state;
    expect(twice).toEqual({ status: "down", pending: RECOVERY_CONFIRMATIONS - 1, pendingStatus: "up", since: 0 });
    // One failed probe resets the recovery count: no "rétabli" e-mail for a blip.
    expect(transition(twice, "down", 3, "production", "HTTP 502")).toEqual({ state: down, alert: null });
  });

  it("alerts P1 for a degraded site and starts unknown sites as up", () => {
    expect(transition({ status: "up", pending: CONFIRMATIONS - 1, pendingStatus: "degraded", since: 0 }, "degraded", 1, "staging", "HTTP 503").alert?.severity).toBe("P1");
    expect(transition(null, "down", 1, "staging", "x")).toEqual({ state: { status: "up", pending: 1, pendingStatus: "down", since: 1 }, alert: null });
  });
});

describe("relay signature", () => {
  it("matches the app's HMAC (src/lib/alert/relay.ts)", async () => {
    const body = '{"severity":"P1","title":"t","body":"b","env":"prod"}';
    const expected = createHmac("sha256", "s3cret").update(`1760000000.${body}`).digest("hex");
    expect(await sign("s3cret", "1760000000", body)).toBe(expected);
    expect(await verifySignature("s3cret", "1760000000", expected, body, 1760000100)).toBe(true);
  });

  it("refuses forged, stale and unsigned requests", async () => {
    const body = "{}";
    const signature = await sign("s3cret", "1760000000", body);
    expect(await verifySignature("s3cret", "1760000000", signature, "{ }", 1760000000)).toBe(false);
    expect(await verifySignature("other", "1760000000", signature, body, 1760000000)).toBe(false);
    expect(await verifySignature("s3cret", "1760000000", signature, body, 1760000301)).toBe(false);
    expect(await verifySignature("s3cret", null, signature, body, 1760000000)).toBe(false);
    expect(await verifySignature("", "1760000000", signature, body, 1760000000)).toBe(false);
  });
});

describe("parsing", () => {
  it("keeps only https targets", () => {
    expect(parseTargets('[{"name":"a","url":"https://a.ma"},{"name":"b","url":"http://b.ma"},{"url":"https://c.ma"}]')).toEqual([{ name: "a", url: "https://a.ma" }]);
    expect(parseTargets("not json")).toEqual([]);
  });

  it("validates relayed alerts", () => {
    expect(parseAlert('{"severity":"P0","title":"t","body":"b"}')).toEqual({ severity: "P0", title: "t", body: "b", env: undefined });
    expect(parseAlert('{"severity":"P9","title":"t","body":"b"}')).toBeNull();
    expect(parseAlert("nope")).toBeNull();
  });
});

describe("emailPayload", () => {
  it("passes the sender through and keeps the subject on one line", () => {
    const payload = emailPayload(FROM, "owner@example.com", { severity: "P0", title: "x\r\nBcc: victim@example.com", body: "é", env: "sta\nging" });
    expect(payload.from).toBe(FROM);
    expect(payload.to).toBe("owner@example.com");
    expect(payload.subject).not.toMatch(/[\r\n]/);
    expect(payload.subject).toBe("Joutiya [sta ging] P0 · x Bcc: victim@example.com");
    expect(payload.text).toContain("Bcc: victim@example.com");
  });

  it("prefixes the environment outside production only", () => {
    expect(emailPayload(FROM, "o@example.com", { ...ALERT, env: "staging" }).subject).toBe("Joutiya [staging] P0 · production : hors ligne");
    expect(emailPayload(FROM, "o@example.com", ALERT).subject).toBe("Joutiya P0 · production : hors ligne");
    expect(emailPayload(FROM, "o@example.com", { ...ALERT, env: undefined }).subject).toBe("Joutiya P0 · production : hors ligne");
  });
});

describe("emailSettings", () => {
  it("is off when both are unset and refuses a half configuration", () => {
    expect(emailSettings(undefined, undefined)).toBeNull();
    expect(emailSettings("", "")).toBeNull();
    expect(emailSettings("o@example.com", KEY)).toEqual({ to: "o@example.com", apiKey: KEY });
    expect(() => emailSettings("o@example.com", undefined)).toThrow(/ALERT_EMAIL_TO and RESEND_API_KEY/);
    expect(() => emailSettings(undefined, KEY)).toThrow(/ALERT_EMAIL_TO and RESEND_API_KEY/);
  });
});

describe("sendViaResend", () => {
  const payload = emailPayload(FROM, "owner@example.com", ALERT);

  it("posts the Resend request shape and returns the quota headers", async () => {
    const { calls, fetchImpl } = fetchStub(json(200, { id: "e1" }, { "x-resend-daily-quota": "3", "x-resend-monthly-quota": "41" }));
    const result = await sendViaResend(fetchImpl, ` ${KEY}\n`, payload, "probe/production/600000", 10_000);
    expect(result).toEqual({ dailyQuota: "3", monthlyQuota: "41" });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [FetchCall];
    expect(url).toBe(RESEND_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "joutiya-uptime-probe",
      "Idempotency-Key": "probe/production/600000",
    });
    expect(JSON.parse(String(init.body))).toEqual({ from: FROM, to: "owner@example.com", subject: "Joutiya P0 · production : hors ligne", text: payload.text });
  });

  it("reports the status and Resend's error name, never the body", async () => {
    await expect(sendViaResend(fetchStub(json(500, { name: "application_error", message: "secret detail" })).fetchImpl, KEY, payload, "k", 1_000)).rejects.toThrow(
      /^resend: HTTP 500 application_error$/,
    );
    await expect(sendViaResend(fetchStub(json(403, { name: "Not an identifier!" })).fetchImpl, KEY, payload, "k", 1_000)).rejects.toThrow(/^resend: HTTP 403$/);
    await expect(sendViaResend(fetchStub(new Response(null, { status: 302, headers: { Location: "https://elsewhere" } })).fetchImpl, KEY, payload, "k", 1_000)).rejects.toThrow(
      /^resend: HTTP 302$/,
    );
  });

  it("retries once on rate_limit_exceeded with the same headers, cron path only", async () => {
    const sleep = vi.fn(async () => undefined);
    const { calls, fetchImpl } = fetchStub(json(429, { name: "rate_limit_exceeded" }, { "retry-after": "7" }), json(200, { id: "e2" }));
    await sendViaResend(fetchImpl, KEY, payload, "probe/staging/1", 10_000, { retryRateLimit: true, sleep });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(calls[1]?.init.headers).toEqual(calls[0]?.init.headers);
    expect(calls[1]?.init.body).toBe(calls[0]?.init.body);

    const relayPath = fetchStub(json(429, { name: "rate_limit_exceeded" }), json(200, { id: "e3" }));
    await expect(sendViaResend(relayPath.fetchImpl, KEY, payload, "relay/sig", 6_000, { sleep })).rejects.toThrow(/^resend: HTTP 429 rate_limit_exceeded$/);
    expect(relayPath.calls).toHaveLength(1);
  });

  it("does not retry quota errors", async () => {
    for (const name of ["daily_quota_exceeded", "monthly_quota_exceeded"]) {
      const { calls, fetchImpl } = fetchStub(json(429, { name }), json(200, { id: "never" }));
      await expect(sendViaResend(fetchImpl, KEY, payload, "k", 10_000, { retryRateLimit: true })).rejects.toThrow(`resend: HTTP 429 ${name}`);
      expect(calls).toHaveLength(1);
    }
  });

  it("never lets the key reach the error or the console", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { fetchImpl } = fetchStub(new Error(`connect failed while sending Authorization: Bearer ${KEY}`));
    const error = await sendViaResend(fetchImpl, KEY, payload, "k", 1_000).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("resend: Error");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(KEY);
  });

  it("gives up at the timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    await expect(sendViaResend(fetchImpl, KEY, payload, "k", 5)).rejects.toThrow(/^resend: TimeoutError$/);
  });
});

describe("daily KV markers", () => {
  const day = Date.UTC(2026, 9, 16, 10);

  it("notices once a day", async () => {
    const kv = memoryKv();
    expect(await markOncePerDay(kv, "resend-quota-notice", day)).toBe(true);
    expect(await markOncePerDay(kv, "resend-quota-notice", day + 3_600_000)).toBe(false);
    expect(await markOncePerDay(kv, "resend-quota-notice", day + 86_400_000)).toBe(true);
    expect([...kv.store.keys()]).toEqual(["resend-quota-notice:2026-10-16", "resend-quota-notice:2026-10-17"]);
  });

  it("caps relayed and probe e-mails per UTC day, each on its own counter", async () => {
    const kv = memoryKv();
    for (let i = 0; i < RELAY_DAILY_CAP; i += 1) expect(await takeDailySlot(kv, "relay", day)).toBe(true);
    expect(await takeDailySlot(kv, "relay", day)).toBe(false);
    expect(kv.store.get("relay-count:2026-10-16")).toBe(String(RELAY_DAILY_CAP));
    expect(await takeDailySlot(kv, "relay", day + 86_400_000)).toBe(true);
    // A flapping target (up to 144 transitions a day) spends the probe counter, not the relay one.
    for (let i = 0; i < PROBE_DAILY_CAP; i += 1) expect(await takeDailySlot(kv, "probe", day)).toBe(true);
    expect(await takeDailySlot(kv, "probe", day)).toBe(false);
    expect(kv.store.get("probe-count:2026-10-16")).toBe(String(PROBE_DAILY_CAP));
    // Both caps together stay well inside Resend's 100 e-mails a day shared with the site.
    expect(PROBE_DAILY_CAP + RELAY_DAILY_CAP).toBeLessThanOrEqual(30);
  });

  it("keeps the last relay e-mails of the day for P0 alerts", async () => {
    const kv = memoryKv();
    for (let i = 0; i < RELAY_DAILY_CAP - RELAY_P0_RESERVE; i += 1) expect(await takeDailySlot(kv, "relay", day, relayCap("P1"))).toBe(true);
    expect(await takeDailySlot(kv, "relay", day, relayCap("P2"))).toBe(false);
    expect(await takeDailySlot(kv, "relay", day, relayCap("info"))).toBe(false);
    for (let i = 0; i < RELAY_P0_RESERVE; i += 1) expect(await takeDailySlot(kv, "relay", day, relayCap("P0"))).toBe(true);
    expect(await takeDailySlot(kv, "relay", day, relayCap("P0"))).toBe(false);
    expect(kv.store.get("relay-count:2026-10-16")).toBe(String(RELAY_DAILY_CAP));
  });
});

describe("relay", () => {
  const nowMs = 1760000000_000;
  const body = JSON.stringify({ severity: "P1", title: "Quota", body: "Firestore à 70 %", env: "prod" });

  async function signedRequest(secret: string, raw = body, timestamp = String(Math.floor(nowMs / 1000))) {
    const signature = await sign(secret, timestamp, raw);
    const request = new Request("https://probe.example/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Joutiya-Timestamp": timestamp, "X-Joutiya-Signature": signature },
      body: raw,
    });
    return { request, signature };
  }

  it("e-mails a valid alert with an idempotency key of the title, environment and UTC hour", async () => {
    const send = vi.fn(async (): Promise<RelayOutcome> => "sent");
    const { request } = await signedRequest("s3cret");
    const response = await relay(request, { secret: "s3cret", nowMs, maxBytes: 16_384, send });
    expect(response.status).toBe(204);
    const hash = createHash("sha256").update("prod\nQuota").digest("hex");
    expect(utcHour(nowMs)).toBe("2025-10-09T08");
    expect(send).toHaveBeenCalledWith({ severity: "P1", title: "Quota", body: "Firestore à 70 %", env: "prod" }, `relay/${hash}/2025-10-09T08`);
  });

  it("answers 429 when the daily cap refuses, 503 when e-mail is off, 204 for a repeat, 502 when sending fails", async () => {
    const deps = { secret: "s3cret", nowMs, maxBytes: 16_384 };
    expect((await relay((await signedRequest("s3cret")).request, { ...deps, send: async () => "capped" as const })).status).toBe(429);
    expect((await relay((await signedRequest("s3cret")).request, { ...deps, send: async () => "off" as const })).status).toBe(503);
    expect((await relay((await signedRequest("s3cret")).request, { ...deps, send: async () => "duplicate" as const })).status).toBe(204);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { request: failing } = await signedRequest("s3cret");
    const response = await relay(failing, {
      secret: "s3cret",
      nowMs,
      maxBytes: 16_384,
      send: async () => {
        throw new Error("resend: HTTP 429 daily_quota_exceeded");
      },
    });
    expect(response.status).toBe(502);
    expect(errorSpy).toHaveBeenCalledWith("email: resend: HTTP 429 daily_quota_exceeded");
  });

  it("refuses bad signatures, stale requests, invalid alerts and oversized bodies without sending", async () => {
    const send = vi.fn(async (): Promise<RelayOutcome> => "sent");
    const deps = { secret: "s3cret", nowMs, maxBytes: 16_384, send };
    expect((await relay((await signedRequest("other")).request, deps)).status).toBe(401);
    expect((await relay((await signedRequest("s3cret", body, "1750000000")).request, deps)).status).toBe(401);
    expect((await relay((await signedRequest("s3cret")).request, { ...deps, secret: "" })).status).toBe(401);
    expect((await relay((await signedRequest("s3cret", '{"severity":"P9"}')).request, deps)).status).toBe(400);
    expect((await relay((await signedRequest("s3cret", "x".repeat(100))).request, { ...deps, maxBytes: 64 })).status).toBe(413);
    const unsigned = new Request("https://probe.example/alert", { method: "POST", body });
    expect((await relay(unsigned, deps)).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("relay idempotency", () => {
  it("keys one title per environment per UTC hour", async () => {
    const hour = Date.UTC(2026, 9, 16, 10, 5);
    const key = await relayIdempotencyKey({ title: "Quota", env: "prod" }, hour);
    expect(key).toMatch(/^relay\/[0-9a-f]{64}\/2026-10-16T10$/);
    expect(key.length).toBeLessThanOrEqual(256);
    expect(await relayIdempotencyKey({ title: "Quota", env: "prod" }, hour + 50 * 60_000)).toBe(key);
    expect(await relayIdempotencyKey({ title: "Quota", env: "prod" }, hour + 60 * 60_000)).not.toBe(key);
    // Staging and production share the Worker: their alerts never collapse into each other.
    expect(await relayIdempotencyKey({ title: "Quota", env: "staging" }, hour)).not.toBe(key);
    expect(await relayIdempotencyKey({ title: "Quota" }, hour)).not.toBe(key);
  });

  it("recognises Resend's refusal of a reused key", () => {
    expect(isIdempotentDuplicate(new Error("resend: HTTP 409 invalid_idempotent_request"))).toBe(true);
    expect(isIdempotentDuplicate(new Error("resend: HTTP 409 concurrent_idempotent_requests"))).toBe(true);
    expect(isIdempotentDuplicate(new Error("resend: HTTP 429 daily_quota_exceeded"))).toBe(false);
    expect(isIdempotentDuplicate("resend: HTTP 409 invalid_idempotent_request")).toBe(false);
  });
});

describe("readCapped", () => {
  it("returns the body up to the cap and null beyond it", async () => {
    const small = new Response('{"severity":"P0"}').body;
    expect(await readCapped(small, 64)).toBe('{"severity":"P0"}');
    const big = new Response("x".repeat(100)).body;
    expect(await readCapped(big, 64)).toBeNull();
    expect(await readCapped(null, 64)).toBe("");
  });
  it("counts only probes that agree: a lone degraded probe inside a recovery window confirms nothing", () => {
    let state: ProbeState = { status: "down", pending: 0, since: 0 };
    for (const observed of ["up", "up"] as const) state = transition(state, observed, 1, "prod", "ok").state;
    const stray = transition(state, "degraded", 2, "prod", "HTTP 503");
    expect(stray.alert).toBeNull();
    expect(stray.state).toEqual({ status: "down", pending: 1, pendingStatus: "degraded", since: 0 });
    // And one down probe after two up probes on a degraded site is not an outage yet.
    let degraded: ProbeState = { status: "degraded", pending: 0, since: 0 };
    for (const observed of ["up", "up"] as const) degraded = transition(degraded, observed, 1, "prod", "ok").state;
    expect(transition(degraded, "down", 2, "prod", "timeout").alert).toBeNull();
  });
});
