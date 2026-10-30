import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractInbound, verifySignature } from "@/lib/phone-verify/webhook";

const SECRET = "unit-test-app-secret";
const PHONE_NUMBER_ID = "100000000000001";

const sign = (raw: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

function payload(messages: unknown[], overrides: { phoneNumberId?: string; statuses?: unknown[]; object?: string } = {}) {
  const value: Record<string, unknown> = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "212600000000", phone_number_id: overrides.phoneNumberId ?? PHONE_NUMBER_ID },
  };
  if (messages.length > 0) value["messages"] = messages;
  if (overrides.statuses) value["statuses"] = overrides.statuses;
  return { object: overrides.object ?? "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value }] }] };
}

const text = (from: string, body: string, id = "wamid.1") => ({ from, id, timestamp: "1760000000", type: "text", text: { body } });

describe("verifySignature", () => {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ note: "é 😀" }] });

  it("accepts the HMAC-SHA256 of the raw body", () => {
    expect(verifySignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifySignature(raw, sign(raw).toUpperCase().replace("SHA256", "sha256"), SECRET)).toBe(true);
  });

  it("refuses a wrong signature, a wrong secret or a changed body", () => {
    expect(verifySignature(raw, sign(raw, "other-secret"), SECRET)).toBe(false);
    expect(verifySignature(`${raw} `, sign(raw), SECRET)).toBe(false);
    expect(verifySignature(raw, `sha256=${"0".repeat(64)}`, SECRET)).toBe(false);
    expect(verifySignature(raw, sign(raw).slice(0, -2), SECRET)).toBe(false);
    expect(verifySignature(raw, sign(raw).replace("sha256=", "sha1="), SECRET)).toBe(false);
  });

  it("refuses a missing header or an empty secret", () => {
    expect(verifySignature(raw, null, SECRET)).toBe(false);
    expect(verifySignature(raw, "", SECRET)).toBe(false);
    expect(verifySignature(raw, sign(raw, ""), "")).toBe(false);
  });
});

describe("extractInbound", () => {
  it("returns the inbound text messages of our number with the 6-digit code", () => {
    const items = extractInbound(payload([text("212612345678", "AALAN 123456", "wamid.a"), text("212712345678", "123456", "wamid.b")]), PHONE_NUMBER_ID);
    expect(items).toEqual([
      { wamid: "wamid.a", from: "212612345678", code: "123456" },
      { wamid: "wamid.b", from: "212712345678", code: "123456" },
    ]);
  });

  it("keeps a message without a usable code (code null) and normalizes the sender to digits", () => {
    const items = extractInbound(payload([text("+212 612 345 678", "salam", "wamid.c"), text("212612345678", "1234567", "wamid.d")]), PHONE_NUMBER_ID);
    expect(items).toEqual([
      { wamid: "wamid.c", from: "212612345678", code: null },
      { wamid: "wamid.d", from: "212612345678", code: null },
    ]);
  });

  it("ignores statuses, other phone number ids and non-text messages", () => {
    expect(extractInbound(payload([], { statuses: [{ id: "wamid.s", status: "delivered" }] }), PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound(payload([text("212612345678", "AALAN 123456")], { phoneNumberId: "999" }), PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound(payload([{ from: "212612345678", id: "wamid.i", type: "image", image: { id: "x" } }]), PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound(payload([{ from: "212612345678", id: "wamid.r", type: "reaction", reaction: { emoji: "👍" } }]), PHONE_NUMBER_ID)).toEqual([]);
  });

  it("ignores malformed payloads and messages without id or sender", () => {
    expect(extractInbound(null, PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound("x", PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound([], PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound({ object: "page", entry: [] }, PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound(payload([text("212612345678", "123456")], { object: "instagram" }), PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound({ object: "whatsapp_business_account", entry: [{ changes: [{ value: null }, "x", { value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, messages: "nope" } }] }] }, PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound(payload([{ id: "wamid.nofrom", type: "text", text: { body: "123456" } }, { from: "212612345678", type: "text", text: { body: "123456" } }]), PHONE_NUMBER_ID)).toEqual([]);
    expect(extractInbound(payload([text("212612345678", "123456")]), "")).toEqual([]);
  });
});
