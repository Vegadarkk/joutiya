import { describe, expect, it } from "vitest";
import { QUOTA_IDS, QUOTAS } from "@/config/quotas";
import { classify, periodKey, retentionSeconds } from "@/lib/quota/period";

describe("quota periods", () => {
  it("buckets Firestore by the Pacific day and others by UTC", () => {
    // 2026-10-13 05:00 UTC is still 2026-10-12 in Los Angeles.
    const at = new Date("2026-10-13T05:00:00Z");
    expect(periodKey(QUOTAS["firestore.reads"], at)).toBe("2026-10-12");
    expect(periodKey(QUOTAS["resend.daily"], at)).toBe("2026-10-13");
    expect(periodKey(QUOTAS["resend.monthly"], at)).toBe("2026-10");
  });

  it("classifies against the alert and degraded thresholds", () => {
    const reads = QUOTAS["firestore.reads"];
    expect(classify(reads, 34_999)).toBe("ok");
    expect(classify(reads, 35_000)).toBe("warning");
    expect(classify(reads, 50_000)).toBe("degraded");
    expect(classify(QUOTAS["claude.budget"], 4_000_000)).toBe("degraded");
  });

  it("keeps counters long enough for the nightly report", () => {
    expect(retentionSeconds({ period: "day" })).toBeGreaterThan(86_400);
    expect(retentionSeconds({ period: "month" })).toBeGreaterThan(31 * 86_400);
  });

  it("alerts before degrading, with a degraded mode for every quota", () => {
    for (const id of QUOTA_IDS) {
      const quota = QUOTAS[id];
      expect(quota.alertAt).toBeLessThan(quota.degradeAt);
      expect(quota.degradedMode.length).toBeGreaterThan(10);
    }
  });
});
