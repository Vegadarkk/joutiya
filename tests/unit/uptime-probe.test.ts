import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONFIRMATIONS, mime, parseAlert, parseTargets, readCapped, sign, transition, verdict, verifySignature, type ProbeState } from "../../workers/uptime-probe/src/lib";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

  it("announces recovery with the incident length", () => {
    const down: ProbeState = { status: "down", pending: CONFIRMATIONS - 1, since: 0 };
    const { alert } = transition(down, "up", 20 * 60_000, "production", "HTTP 200");
    expect(alert?.severity).toBe("info");
    expect(alert?.body).toContain("20 min");
  });

  it("alerts P1 for a degraded site and starts unknown sites as up", () => {
    expect(transition({ status: "up", pending: CONFIRMATIONS - 1, since: 0 }, "degraded", 1, "staging", "HTTP 503").alert?.severity).toBe("P1");
    expect(transition(null, "down", 1, "staging", "x")).toEqual({ state: { status: "up", pending: 1, since: 1 }, alert: null });
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

describe("mime", () => {
  it("encodes header values so alert text cannot inject headers", () => {
    const raw = mime("alertes@joutiya.ma", "owner@example.com", { severity: "P0", title: "x\r\nBcc: victim@example.com", body: "é" }, new Date(0), "id1");
    const [head] = raw.split("\r\n\r\n");
    expect(head).not.toContain("Bcc:");
    expect(head).toContain("Subject: =?UTF-8?B?");
    expect(head).toContain("Message-ID: <id1@joutiya.ma>");
  });
});

describe("readCapped", () => {
  it("returns the body up to the cap and null beyond it", async () => {
    const small = new Response("{\"severity\":\"P0\"}").body;
    expect(await readCapped(small, 64)).toBe('{"severity":"P0"}');
    const big = new Response("x".repeat(100)).body;
    expect(await readCapped(big, 64)).toBeNull();
    expect(await readCapped(null, 64)).toBe("");
  });
});
