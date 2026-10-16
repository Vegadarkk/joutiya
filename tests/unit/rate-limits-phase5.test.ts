import { describe, expect, it } from "vitest";
import { RATE_LIMITS, type RateLimitDefinition } from "@/config/rate-limits";
import { REPORT_REASONS, SLA_MS, reasonsFor, reportReason, slaDueAt } from "@/config/report-reasons";
import { DEFAULT_AI, resolveAiConfig } from "@/config/ai";

// Phase 5 limiters (architecture §6, design phase-5 §2), report reasons and the AI config defaults.

const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;

const expected: Record<string, RateLimitDefinition> = {
  "message.send.uid": { points: 20, duration: MINUTE, policy: "open", key: "uid" },
  "conversation.new.uid": { points: 50, duration: DAY, policy: "open", key: "uid" },
  "conversation.new.young.uid": { points: 10, duration: DAY, policy: "open", key: "uid" },
  "conversation.state.uid": { points: 600, duration: HOUR, policy: "open", key: "uid" },
  "messages.unread.uid": { points: 600, duration: HOUR, policy: "open", key: "uid" },
  "report.uid": { points: 20, duration: DAY, policy: "open", key: "uid" },
  "report.device": { points: 5, duration: HOUR, policy: "open", key: "device" },
  "report.ip": { points: 20, duration: HOUR, policy: "open", key: "ip" },
  "report.p0.uid": { points: 3, duration: DAY, policy: "open", key: "uid" },
  "report.p0.device": { points: 2, duration: DAY, policy: "open", key: "device" },
  "report.p0.ip": { points: 5, duration: DAY, policy: "open", key: "ip" },
  "appeal.uid": { points: 10, duration: DAY, policy: "closed", key: "uid" },
  "appeal.link.ip": { points: 30, duration: HOUR, policy: "closed", key: "ip" },
  "assistant.device.hour": { points: 20, duration: HOUR, policy: "closed", key: "device" },
  "assistant.device.day": { points: 50, duration: DAY, policy: "closed", key: "device" },
  "assistant.ip": { points: 200, duration: DAY, policy: "closed", key: "ip" },
  "admin.read.uid": { points: 3000, duration: HOUR, policy: "open", key: "uid" },
  "admin.conversation.uid": { points: 60, duration: HOUR, policy: "closed", key: "uid" },
};

describe("phase 5 rate limits", () => {
  it.each(Object.entries(expected))("%s matches the architecture", (id, definition) => {
    expect(RATE_LIMITS[id as keyof typeof RATE_LIMITS]).toEqual(definition);
  });
});

describe("report reasons", () => {
  it("has unique ids and P0 reasons for every target type", () => {
    const ids = REPORT_REASONS.map((reason) => reason.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const target of ["listing", "user", "message", "pro"] as const) {
      expect(reasonsFor(target).some((reason) => reason.priority === "P0")).toBe(true);
      expect(reasonsFor(target).at(-1)?.id).toBe("other");
    }
  });

  it("orders reasons by priority and gives every one a French and Arabic label", () => {
    const order = REPORT_REASONS.map((reason) => Number(reason.priority.slice(1)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const reason of REPORT_REASONS) {
      expect(reason.label.fr.length).toBeGreaterThan(3);
      expect(reason.label.ar.length).toBeGreaterThan(3);
    }
  });

  it("maps priorities to the target delays of the architecture", () => {
    expect(SLA_MS).toEqual({ P0: 3_600_000, P1: 86_400_000, P2: 3 * 86_400_000, P3: 7 * 86_400_000 });
    const at = new Date("2026-10-16T10:00:00Z");
    expect(slaDueAt("P0", at).toISOString()).toBe("2026-10-16T11:00:00.000Z");
    expect(reportReason("scam")?.priority).toBe("P1");
    expect(reportReason("nope")).toBeUndefined();
  });

  it("only offers content reasons where they make sense", () => {
    expect(reasonsFor("message").map((reason) => reason.id)).not.toContain("counterfeit");
    expect(reasonsFor("listing").map((reason) => reason.id)).not.toContain("harassment");
  });
});

describe("AI config phase 5 defaults", () => {
  it("carries the agent thresholds of the architecture", () => {
    expect(DEFAULT_AI.agent).toEqual({ autoApproveAt: 0.9, autoRejectSpamAt: 0.97, autoApproveSoftFlags: [], screenPublished: true });
    expect(DEFAULT_AI.models.appeal).toBe("claude-sonnet-5-5");
    expect(DEFAULT_AI.prices["claude-haiku-5-5"]?.input).toBe(0.1);
  });

  it("resolves an empty stored document to the defaults", () => {
    expect(resolveAiConfig(undefined)).toEqual({ config: DEFAULT_AI, errors: [] });
    expect(resolveAiConfig({ reports: { autoHideNsfwAt: 0.99 } }).config.reports.autoHideNsfwAt).toBe(0.99);
  });
});
