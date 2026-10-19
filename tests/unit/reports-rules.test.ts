import { describe, expect, it } from "vitest";
import {
  ABUSIVE_SUSPENSION_MS,
  applyReporterOutcome,
  findDuplicate,
  hasAutoSignal,
  hasMultiSignal,
  isCorroborated,
  p0Alert,
  parisTime,
  priorityRank,
  raisePriority,
  slaHours,
  strongSignalOf,
  trustedFromFacts,
  type OpenReportLike,
  type ReporterStats,
  type SignalReport,
} from "@/lib/reports/rules";

// Pure rules of the reports (design D10 dedupe, D11 strong signals and trusted reporter, D12 P0
// alert, D15 reporter accuracy and art. 23): no Firestore, no clock.

const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("priorities and delays", () => {
  it("orders P0 first and gives the SLA in hours", () => {
    expect(priorityRank("P0")).toBeLessThan(priorityRank("P3"));
    expect([slaHours("P0"), slaHours("P1"), slaHours("P2"), slaHours("P3")]).toEqual([1, 24, 72, 168]);
  });
});

describe("findDuplicate (D10)", () => {
  const byAccount = (priority: OpenReportLike["priority"], uid = "u1"): OpenReportLike => ({ priority, source: "user", reporter: { uid, deviceHash: "dev-a" } });
  const byVisitor = (priority: OpenReportLike["priority"], deviceHash = "dev-v"): OpenReportLike => ({ priority, source: "user", reporter: { deviceHash } });

  it("matches the same account, whatever its device", () => {
    expect(findDuplicate([byAccount("P1")], { uid: "u1", deviceHash: "other" }, "P1")).toBeDefined();
    expect(findDuplicate([byAccount("P1")], { uid: "u2", deviceHash: "dev-a" }, "P1")).toBeUndefined();
  });

  it("matches a visitor by device only, never an account's report on that device", () => {
    expect(findDuplicate([byVisitor("P2")], { deviceHash: "dev-v" }, "P2")).toBeDefined();
    expect(findDuplicate([byVisitor("P2")], { deviceHash: "dev-w" }, "P2")).toBeUndefined();
    expect(findDuplicate([byAccount("P2")], { deviceHash: "dev-a" }, "P2")).toBeUndefined();
  });

  it("does not swallow a more urgent reason (P3 then P0 is a new report)", () => {
    expect(findDuplicate([byAccount("P3")], { uid: "u1", deviceHash: "x" }, "P0")).toBeUndefined();
    expect(findDuplicate([byAccount("P0")], { uid: "u1", deviceHash: "x" }, "P3")).toBeDefined();
  });

  it("ignores system and authority reports", () => {
    expect(findDuplicate([{ priority: "P1", source: "system", reporter: { deviceHash: "dev-v" } }], { deviceHash: "dev-v" }, "P1")).toBeUndefined();
  });
});

describe("hasMultiSignal (D11 multi)", () => {
  const report = (uid: string | undefined, deviceHash: string, ipPrefixHash: string, createdAt = ago(DAY)): SignalReport => ({ ...(uid ? { uid } : {}), deviceHash, ipPrefixHash, createdAt });
  const candidate = report("u1", "d1", "ip1", NOW);

  it("needs another reporter distinct by account, device and IP prefix", () => {
    expect(hasMultiSignal(candidate, [report("u2", "d2", "ip2")], NOW)).toBe(true);
    expect(hasMultiSignal(candidate, [report("u2", "d2", "ip1")], NOW)).toBe(false);
    expect(hasMultiSignal(candidate, [report("u2", "d1", "ip2")], NOW)).toBe(false);
    expect(hasMultiSignal(candidate, [report("u1", "d2", "ip2")], NOW)).toBe(false);
  });

  it("is false alone (a lone P0 hides nothing)", () => {
    expect(hasMultiSignal(candidate, [], NOW)).toBe(false);
  });

  it("counts reports of the last 7 days only", () => {
    expect(hasMultiSignal(candidate, [report("u2", "d2", "ip2", ago(8 * DAY))], NOW)).toBe(false);
    expect(hasMultiSignal(candidate, [report("u2", "d2", "ip2", ago(7 * DAY))], NOW)).toBe(true);
  });

  it("never counts a visitor: the strong signal needs two accounts (audit D1a-03)", () => {
    const visitor = report(undefined, "d1", "ip1", NOW);
    expect(hasMultiSignal(visitor, [report(undefined, "d2", "ip2")], NOW)).toBe(false);
    expect(hasMultiSignal(visitor, [report("u2", "d2", "ip2")], NOW)).toBe(false);
    expect(hasMultiSignal(candidate, [report(undefined, "d2", "ip2")], NOW)).toBe(false);
  });

  it("isCorroborated: another reporter on a distinct device and network, visitors included, within 7 days", () => {
    const visitor = report(undefined, "d1", "ip1", NOW);
    expect(isCorroborated(visitor, [report(undefined, "d2", "ip2")], NOW)).toBe(true);
    expect(isCorroborated(visitor, [report("u2", "d2", "ip2")], NOW)).toBe(true);
    expect(isCorroborated(candidate, [report(undefined, "d2", "ip2")], NOW)).toBe(true);
    expect(isCorroborated(visitor, [report(undefined, "d1", "ip2")], NOW)).toBe(false);
    expect(isCorroborated(visitor, [report(undefined, "d2", "ip1")], NOW)).toBe(false);
    expect(isCorroborated(candidate, [report("u1", "d2", "ip2")], NOW)).toBe(false);
    expect(isCorroborated(visitor, [report(undefined, "d2", "ip2", ago(8 * DAY))], NOW)).toBe(false);
    expect(isCorroborated(visitor, [], NOW)).toBe(false);
  });

  it("raisePriority: one rank more urgent, never to P0", () => {
    expect(raisePriority("P3")).toBe("P2");
    expect(raisePriority("P2")).toBe("P1");
    expect(raisePriority("P1")).toBe("P1");
    expect(raisePriority("P0")).toBe("P0");
  });
});

describe("trustedFromFacts (D11 trusted)", () => {
  const user = (overrides: Partial<{ createdAt: Date; status: "active" | "restricted"; phoneVerified: boolean }> = {}) => ({
    createdAt: overrides.createdAt ?? ago(60 * DAY),
    status: overrides.status ?? ("active" as const),
    badges: { emailVerified: true, phoneVerified: overrides.phoneVerified ?? true, proCertified: false },
  });
  const reporter = (recent: boolean[], extra: Partial<ReporterStats> = {}): ReporterStats => ({ recent, total: recent.length, ...extra });

  it("trusts 5 decided reports with 80 % founded on an old, verified, active account", () => {
    expect(trustedFromFacts({ user: user(), reporter: reporter([true, true, true, true, false]), now: NOW })).toBe(true);
  });

  it("refuses below each threshold", () => {
    expect(trustedFromFacts({ user: user(), reporter: reporter([true, true, true, true]), now: NOW })).toBe(false);
    expect(trustedFromFacts({ user: user(), reporter: reporter([true, true, true, false, false]), now: NOW })).toBe(false);
    expect(trustedFromFacts({ user: user({ createdAt: ago(29 * DAY) }), reporter: reporter([true, true, true, true, true]), now: NOW })).toBe(false);
    expect(trustedFromFacts({ user: user({ phoneVerified: false }), reporter: reporter([true, true, true, true, true]), now: NOW })).toBe(false);
    expect(trustedFromFacts({ user: user({ status: "restricted" }), reporter: reporter([true, true, true, true, true]), now: NOW })).toBe(false);
    expect(trustedFromFacts({ user: user(), reporter: reporter([true, true, true, true, true], { abusiveUntil: new Date(NOW.getTime() + DAY) }), now: NOW })).toBe(false);
    expect(trustedFromFacts({ user: null, reporter: reporter([true, true, true, true, true]), now: NOW })).toBe(false);
  });
});

describe("strongSignalOf", () => {
  it("only for P0, strongest signal first", () => {
    expect(strongSignalOf("P1", { trusted: true, auto: true, multi: true })).toBeUndefined();
    expect(strongSignalOf("P0", { trusted: false, auto: false, multi: false })).toBeUndefined();
    expect(strongSignalOf("P0", { trusted: true, auto: true, multi: true })).toBe("trusted");
    expect(strongSignalOf("P0", { trusted: false, auto: true, multi: true })).toBe("auto");
    expect(strongSignalOf("P0", { trusted: false, auto: false, multi: true })).toBe("multi");
  });

  it("auto: a stored nudity score at or above the threshold", () => {
    expect(hasAutoSignal([0.1, undefined, 0.95], 0.95)).toBe(true);
    expect(hasAutoSignal([0.94, undefined], 0.95)).toBe(false);
    expect(hasAutoSignal([], 0.95)).toBe(false);
  });
});

describe("applyReporterOutcome (D15, art. 23)", () => {
  it("keeps the last 10 outcomes and counts every decision", () => {
    let reporter: ReporterStats | null = null;
    for (let i = 0; i < 12; i += 1) reporter = applyReporterOutcome(reporter, { founded: i % 2 === 0 }, NOW).reporter;
    expect(reporter?.recent).toHaveLength(10);
    expect(reporter?.total).toBe(12);
    expect(reporter?.recent.at(-1)).toBe(false);
    expect(reporter?.manifest).toBeUndefined();
  });

  it("warns at the third manifestly unfounded report in 30 days, then suspends at the next one", () => {
    let reporter: ReporterStats = { recent: [], total: 0 };
    const steps: { warn: boolean; abusive: boolean }[] = [];
    for (const day of [20, 10, 5]) {
      const update = applyReporterOutcome(reporter, { founded: false, manifestlyUnfounded: true }, ago(day * DAY));
      reporter = update.reporter;
      steps.push({ warn: update.warn, abusive: update.abusive });
    }
    expect(steps).toEqual([
      { warn: false, abusive: false },
      { warn: false, abusive: false },
      { warn: true, abusive: false },
    ]);
    expect(reporter.warnedAt).toEqual(ago(5 * DAY));
    const fourth = applyReporterOutcome(reporter, { founded: false, manifestlyUnfounded: true }, NOW);
    expect(fourth.abusive).toBe(true);
    expect(fourth.reporter.abusiveUntil).toEqual(new Date(NOW.getTime() + ABUSIVE_SUSPENSION_MS));
  });

  it("ignores manifestly unfounded reports older than 30 days and a plain dismissal", () => {
    let reporter: ReporterStats = { recent: [], total: 0, manifest: [ago(45 * DAY), ago(40 * DAY)] };
    reporter = applyReporterOutcome(reporter, { founded: false }, NOW).reporter;
    const update = applyReporterOutcome(reporter, { founded: false, manifestlyUnfounded: true }, NOW);
    expect(update.warn).toBe(false);
    expect(update.reporter.manifest).toHaveLength(3);
  });

  it("starts a new warning cycle once the warning is older than 30 days", () => {
    const reporter: ReporterStats = { recent: [], total: 3, manifest: [ago(70 * DAY), ago(65 * DAY), ago(60 * DAY)], warnedAt: ago(60 * DAY) };
    const update = applyReporterOutcome(reporter, { founded: false, manifestlyUnfounded: true }, NOW);
    expect(update).toMatchObject({ warn: false, abusive: false });
  });

  it("never flags a founded report", () => {
    const update = applyReporterOutcome({ recent: [], total: 0, warnedAt: ago(DAY) }, { founded: true, manifestlyUnfounded: true }, NOW);
    expect(update).toMatchObject({ warn: false, abusive: false });
    expect(update.reporter.abusiveUntil).toBeUndefined();
  });
});

describe("p0Alert (D12)", () => {
  it("has a unique title and no personal data", () => {
    const alert = p0Alert({ reportId: "Rep0rt1d", targetType: "listing", reasonId: "minors", signal: "multi", hidden: true, slaDueAt: new Date("2026-10-16T13:00:00Z"), source: "user" });
    expect(alert.severity).toBe("P0");
    expect(alert.title).toBe("Signalement P0 Rep0rt1d");
    expect(alert.body).toContain("Cible : annonce");
    expect(alert.body).toContain("Motif : minors");
    expect(alert.body).toContain("Signal fort : oui (multi)");
    expect(alert.body).toContain(`Échéance : ${parisTime(new Date("2026-10-16T13:00:00Z"))} (Paris)`);
    expect(parisTime(new Date("2026-10-16T13:00:00Z"))).toContain("15:00");
  });

  it("says when there is no strong signal", () => {
    expect(p0Alert({ reportId: "x", targetType: "message", reasonId: "threat", hidden: false, slaDueAt: NOW, source: "user" }).body).toContain("Signal fort : non");
  });
});
