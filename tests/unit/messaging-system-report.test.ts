import { afterEach, describe, expect, it, vi } from "vitest";

// The repeat-risk rule (design D5) files its report through the reports lot: target user (uid and
// publicId), reason scam, source system, the explanation as given (no message text).

vi.mock("@/lib/reports", () => ({ createSystemReport: vi.fn(async () => ({ reportId: "r1", duplicate: false, priority: "P1", hidden: false })) }));

const { createSystemReport } = await import("@/lib/reports");
const { fileRepeatRiskReport, setRepeatRiskReporter } = await import("@/lib/messaging/system-report");

afterEach(() => setRepeatRiskReporter(undefined));

describe("fileRepeatRiskReport", () => {
  it("creates a system scam report on the sender's account", async () => {
    await fileRepeatRiskReport({ uid: "u1", publicId: "abcdefgh23", explanation: "Règle automatique : 3 messages à risque." });
    expect(createSystemReport).toHaveBeenCalledWith({
      target: { type: "user", id: "u1", ownerUid: "u1", publicId: "abcdefgh23" },
      reasonId: "scam",
      explanation: "Règle automatique : 3 messages à risque.",
      source: "system",
    });
  });

  it("can be replaced in tests and restored", async () => {
    const spy = vi.fn(async () => undefined);
    setRepeatRiskReporter(spy);
    await fileRepeatRiskReport({ uid: "u2", publicId: "abcdefgh24", explanation: "x".repeat(20) });
    expect(spy).toHaveBeenCalledOnce();
    expect(createSystemReport).not.toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ id: "u2" }) }));
  });
});
