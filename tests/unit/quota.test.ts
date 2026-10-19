import { describe, expect, it } from "vitest";
import { QUOTA_IDS, QUOTAS } from "@/config/quotas";
import { classify, periodKey, retentionSeconds } from "@/lib/quota/period";
import { RELAY_DAILY_CAP } from "../../workers/uptime-probe/src/lib";

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

  it("leaves the uptime Worker's relay cap out of the app's share of Resend's 100 mails a day", () => {
    expect(QUOTAS["resend.daily"].limit + RELAY_DAILY_CAP).toBe(100);
    // Non-security mails stop at 90 % of the app's share; security mails keep the rest.
    expect(classify(QUOTAS["resend.daily"], 72)).toBe("degraded");
    expect(classify(QUOTAS["resend.daily"], 71)).toBe("warning");
  });

  it("guards the delivery incidents and the Sentry events too (alert at 70 %, no silent spending)", () => {
    expect(QUOTAS["resend.bounces"]).toMatchObject({ limit: 10, period: "day", resetTimeZone: "UTC", kind: "counter", alertAt: 0.7, degradeAt: 1 });
    expect(QUOTAS["resend.complaints"]).toMatchObject({ limit: 3, period: "day", resetTimeZone: "UTC", kind: "counter", alertAt: 0.7, degradeAt: 1 });
    expect(classify(QUOTAS["resend.bounces"], 7)).toBe("warning");
    expect(classify(QUOTAS["resend.complaints"], 3)).toBe("degraded");
    expect(QUOTAS["sentry.events"]).toMatchObject({ limit: 5_000, period: "month", resetTimeZone: "UTC", kind: "counter", alertAt: 0.7, degradeAt: 0.9 });
    expect(classify(QUOTAS["sentry.events"], 4_500)).toBe("degraded");
    expect(periodKey(QUOTAS["sentry.events"], new Date("2026-10-13T05:00:00Z"))).toBe("2026-10");
  });
});

describe("nextPeriodStart", () => {
  it("finds the provider's reset instant within a second, DST included", async () => {
    const { nextPeriodStart } = await import("@/lib/quota/period");
    const near = (date: Date, iso: string) => {
      expect(date.getTime()).toBeGreaterThanOrEqual(Date.parse(iso));
      expect(date.getTime()).toBeLessThanOrEqual(Date.parse(iso) + 1_000);
    };
    near(nextPeriodStart({ period: "day", resetTimeZone: "UTC" }, new Date("2026-10-16T23:59:59.500Z")), "2026-10-17T00:00:00Z");
    near(nextPeriodStart({ period: "day", resetTimeZone: "UTC" }, new Date("2026-10-17T00:00:00Z")), "2026-10-18T00:00:00Z");
    // Pacific day on the DST switch (2026-11-01, 02:00 PDT → 01:00 PST): next midnight is 08:00 UTC.
    near(nextPeriodStart({ period: "day", resetTimeZone: "America/Los_Angeles" }, new Date("2026-11-01T12:00:00Z")), "2026-11-02T08:00:00Z");
    near(nextPeriodStart({ period: "month", resetTimeZone: "UTC" }, new Date("2026-02-10T00:00:00Z")), "2026-03-01T00:00:00Z");
  });
});
