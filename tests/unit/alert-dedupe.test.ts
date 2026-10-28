import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));

const configured = { value: false };
const set = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => "OK");
vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => configured.value, valkey: () => ({ set }) }));

const { alert, ALERT_DEDUPE_SECONDS, setAlertChannels } = await import("@/lib/alert");

const send = vi.fn(async () => undefined);
const event = (title: string) => ({ severity: "P1" as const, title, body: "corps" });

beforeEach(() => {
  configured.value = false;
  send.mockClear();
  set.mockReset();
  set.mockResolvedValue("OK");
  setAlertChannels([{ name: "test", send }]);
});

afterEach(() => {
  vi.useRealTimers();
  setAlertChannels(undefined);
});

describe("alert dedupe", () => {
  it("sends the same title once an hour (in-process marker without Valkey)", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T10:00:00Z") });
    expect(await alert(event("Quota A"))).toBe(true);
    expect(await alert(event("Quota A"))).toBe(false);
    expect(await alert(event("Quota B"))).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-16T10:59:59Z"));
    expect(await alert(event("Quota A"))).toBe(false);
    vi.setSystemTime(new Date("2026-10-16T11:00:01Z"));
    expect(await alert(event("Quota A"))).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(event("Quota A"), "dev");
  });

  it("uses SET NX EX 3600 on a hash of the title in valkey-queue", async () => {
    configured.value = true;
    set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    expect(await alert(event("Mail: bascule sur Brevo"))).toBe(true);
    expect(await alert(event("Mail: bascule sur Brevo"))).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[0]).toEqual([expect.stringMatching(/^alert:sent:[0-9a-f]{32}$/), "1", "EX", ALERT_DEDUPE_SECONDS, "NX"]);
    expect(ALERT_DEDUPE_SECONDS).toBe(3_600);
    expect(String(set.mock.calls[0]?.[0])).not.toContain("Brevo");
  });

  it("fails open when Valkey is down", async () => {
    configured.value = true;
    set.mockRejectedValue(new Error("connection closed"));
    expect(await alert(event("Valkey down"))).toBe(true);
    expect(await alert(event("Valkey down"))).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("still delivers on the other channels when one fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("telegram: HTTP 500");
    });
    setAlertChannels([{ name: "telegram", send: failing }, { name: "test", send }]);
    expect(await alert(event("Un canal en panne"))).toBe(true);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("alert delivery log", () => {
  it("logs each channel as sent or failed, so a silent channel shows in the logs", async () => {
    const { logger } = await import("@/lib/logging/logger");
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.error).mockClear();
    const broken = vi.fn(async () => {
      throw new Error("down");
    });
    setAlertChannels([{ name: "telegram", send }, { name: "relay", send: broken }]);
    expect(await alert(event("Signalement P0"))).toBe(true);
    expect(logger.info).toHaveBeenCalledWith({ channel: "telegram", alert: { severity: "P1" } }, "alert channel sent");
    expect(logger.error).toHaveBeenCalledWith({ channel: "relay", err: "Error: down" }, "alert channel failed");
  });
});

describe("deliver", () => {
  it("reports each channel's outcome, an e-mail relay switched off included", async () => {
    const { deliver } = await import("@/lib/alert");
    const off = vi.fn(async () => "off" as const);
    const broken = vi.fn(async () => {
      throw new Error("down");
    });
    setAlertChannels([{ name: "telegram", send }, { name: "email", send: off }, { name: "other", send: broken }]);
    expect(await deliver(event("Exercice"))).toEqual([
      { channel: "telegram", status: "sent" },
      { channel: "email", status: "off" },
      { channel: "other", status: "failed", error: "Error: down" },
    ]);
  });
});
