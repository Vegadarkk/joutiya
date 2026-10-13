import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RelayEmailChannel } from "@/lib/alert/relay";
import { TelegramChannel } from "@/lib/alert/telegram";
import { formatAlert } from "@/lib/alert/types";

const ALERT = { severity: "P1", title: "Quota", body: "Firestore à 70 %" } as const;

describe("formatAlert", () => {
  it("prefixes non-production environments and caps the length", () => {
    expect(formatAlert(ALERT, "prod")).toBe("🔴 P1 · Quota\n\nFirestore à 70 %");
    expect(formatAlert(ALERT, "staging")).toContain("[staging] P1");
    expect(formatAlert({ ...ALERT, body: "x".repeat(5000) }, "prod").length).toBeLessThanOrEqual(4000);
  });
});

describe("TelegramChannel", () => {
  it("never leaks the bot token in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    const channel = new TelegramChannel("123:SECRET", "42", fetchImpl as unknown as typeof fetch);
    const error = await channel.send(ALERT, "prod").catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("SECRET");
  });
});

describe("RelayEmailChannel", () => {
  it("signs timestamp and body with HMAC-SHA256", async () => {
    let request: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      request = init;
      return new Response(null, { status: 204 });
    });
    await new RelayEmailChannel("https://probe.example/alert", "s3cret", fetchImpl as unknown as typeof fetch).send(ALERT, "prod");
    const headers = request?.headers as Record<string, string>;
    const body = String(request?.body);
    const expected = createHmac("sha256", "s3cret").update(`${headers["X-Joutiya-Timestamp"]}.${body}`).digest("hex");
    expect(headers["X-Joutiya-Signature"]).toBe(expected);
    expect(JSON.parse(body)).toEqual({ ...ALERT, env: "prod" });
  });
});
