import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleMailEvent, svixHeaders, verifySvix, type SuppressionStore } from "@/lib/mail/webhook";

vi.mock("@/lib/mail/suppressions", () => ({ addSuppression: vi.fn() }));

const rawKey = randomBytes(24);
const SECRET = `whsec_${rawKey.toString("base64")}`;
const NOW = Date.parse("2026-10-16T10:00:00Z");
const ID = "msg_2PdYz7w9ZbQk1xJ3";

function sign(raw: string, timestamp: number, key: Buffer = rawKey, id = ID): string {
  return createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
}

const headers = (raw: string, timestamp = Math.floor(NOW / 1000), signature?: string) => ({
  id: ID,
  timestamp: String(timestamp),
  signature: signature ?? `v1,${sign(raw, timestamp)}`,
});

const bounce = (type: string, to: string[] = ["nadia@example.com"]) =>
  JSON.stringify({
    type: "email.bounced",
    created_at: "2026-10-16T10:00:00.000Z",
    data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618", from: "Joutiya <no-reply@notif.joutiya.ma>", to, subject: "x", bounce: { message: "m", subType: "General", type }, tags: { template: "verifyEmail" } },
  });

describe("verifySvix", () => {
  const raw = bounce("Permanent");

  it("accepts a valid signature", () => {
    expect(verifySvix(raw, headers(raw), SECRET, NOW)).toBe(true);
  });

  it("accepts the bare base64 secret too", () => {
    expect(verifySvix(raw, headers(raw), rawKey.toString("base64"), NOW)).toBe(true);
  });

  it("rejects a wrong signature, a wrong key and a tampered body", () => {
    expect(verifySvix(raw, headers(raw, undefined, `v1,${sign(raw, Math.floor(NOW / 1000), randomBytes(24))}`), SECRET, NOW)).toBe(false);
    expect(verifySvix(raw, headers(raw), `whsec_${randomBytes(24).toString("base64")}`, NOW)).toBe(false);
    expect(verifySvix(raw.replace("Permanent", "Transient"), headers(raw), SECRET, NOW)).toBe(false);
    expect(verifySvix(raw, headers(raw, undefined, "v1,"), SECRET, NOW)).toBe(false);
    expect(verifySvix(raw, headers(raw, undefined, "v0,abc"), SECRET, NOW)).toBe(false);
  });

  it("rejects a stale or future timestamp beyond five minutes", () => {
    const stale = Math.floor(NOW / 1000) - 301;
    expect(verifySvix(raw, headers(raw, stale), SECRET, NOW)).toBe(false);
    const future = Math.floor(NOW / 1000) + 301;
    expect(verifySvix(raw, headers(raw, future), SECRET, NOW)).toBe(false);
    const edge = Math.floor(NOW / 1000) - 300;
    expect(verifySvix(raw, headers(raw, edge), SECRET, NOW)).toBe(true);
    expect(verifySvix(raw, { ...headers(raw), timestamp: "2026-10-16T10:00:00Z" }, SECRET, NOW)).toBe(false);
  });

  it("accepts when any v1 entry matches", () => {
    const good = sign(raw, Math.floor(NOW / 1000));
    const other = sign(raw, Math.floor(NOW / 1000), randomBytes(24));
    expect(verifySvix(raw, headers(raw, undefined, `v1,${other} v1,${good}`), SECRET, NOW)).toBe(true);
    expect(verifySvix(raw, headers(raw, undefined, `v1,${other} v1,${other}`), SECRET, NOW)).toBe(false);
  });

  it("rejects missing headers and an empty secret", () => {
    expect(verifySvix(raw, { ...headers(raw), id: null }, SECRET, NOW)).toBe(false);
    expect(verifySvix(raw, { ...headers(raw), signature: undefined }, SECRET, NOW)).toBe(false);
    expect(verifySvix(raw, headers(raw), "", NOW)).toBe(false);
    expect(verifySvix(raw, headers(raw), "whsec_", NOW)).toBe(false);
  });

  it("reads the svix-* headers", () => {
    const h = new Headers({ "svix-id": ID, "svix-timestamp": "1", "svix-signature": "v1,x" });
    expect(svixHeaders(h)).toEqual({ id: ID, timestamp: "1", signature: "v1,x" });
  });
});

describe("handleMailEvent", () => {
  const store = (): SuppressionStore & { addSuppression: ReturnType<typeof vi.fn> } => ({ addSuppression: vi.fn(async () => undefined) });

  it("suppresses every recipient of a permanent bounce", async () => {
    const s = store();
    const outcome = await handleMailEvent(bounce("Permanent", ["a@example.com", "b@example.com"]), s);
    expect(outcome).toEqual({ handled: "bounce", recipients: 2 });
    expect(s.addSuppression).toHaveBeenCalledTimes(2);
    expect(s.addSuppression).toHaveBeenCalledWith("a@example.com", "bounce", "resend");
    expect(s.addSuppression).toHaveBeenCalledWith("b@example.com", "bounce", "resend");
  });

  it("ignores soft bounces whatever their spelling", async () => {
    for (const type of ["Transient", "Temporary", "Undetermined", ""]) {
      const s = store();
      expect(await handleMailEvent(bounce(type), s)).toEqual({ handled: "ignored", reason: "soft_bounce" });
      expect(s.addSuppression).not.toHaveBeenCalled();
    }
    expect((await handleMailEvent(bounce("permanent"), store())).handled).toBe("bounce");
  });

  it("suppresses complaints and accepts a string recipient", async () => {
    const s = store();
    const raw = JSON.stringify({ type: "email.complained", created_at: "x", data: { email_id: "1", to: "nadia@example.com", tags: {} } });
    expect(await handleMailEvent(raw, s)).toEqual({ handled: "complaint", recipients: 1 });
    expect(s.addSuppression).toHaveBeenCalledWith("nadia@example.com", "complaint", "resend");
  });

  it("ignores other events, invalid JSON and malformed payloads", async () => {
    const s = store();
    expect(await handleMailEvent(JSON.stringify({ type: "email.delivered", data: { to: ["a@example.com"] } }), s)).toEqual({ handled: "ignored", reason: "email.delivered" });
    expect(await handleMailEvent("{not json", s)).toEqual({ handled: "ignored", reason: "invalid_json" });
    expect(await handleMailEvent(JSON.stringify({ data: {} }), s)).toEqual({ handled: "ignored", reason: "invalid_event" });
    expect(await handleMailEvent(JSON.stringify({ type: "email.bounced", data: { to: ["not-an-address"], bounce: { type: "Permanent" } } }), s)).toEqual({ handled: "ignored", reason: "invalid_event" });
    expect(s.addSuppression).not.toHaveBeenCalled();
  });
});
