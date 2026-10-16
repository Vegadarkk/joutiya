import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/quota", () => ({
  consume: vi.fn(async () => ({ level: "ok" })),
  isDegraded: vi.fn(async () => false),
  firstDegraded: vi.fn(async () => null),
  headroom: vi.fn(async () => null),
}));
vi.mock("@/lib/logging/connection-logs", () => ({ deleteConnectionLogsPastPurge: vi.fn(), oldestConnectionLogPastPurge: vi.fn(async () => null) }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirebaseConfigured: () => configured.value, isFirestoreConfigured: () => configured.value, db: vi.fn(), auth: vi.fn() }));

const { alert } = await import("@/lib/alert");
const { firstDegraded, headroom } = await import("@/lib/quota");
const { deleteConnectionLogsPastPurge, oldestConnectionLogPastPurge } = await import("@/lib/logging/connection-logs");
const { purgeConnectionLogs, CONNECTION_LOG_BATCH, CONNECTION_LOG_PURGE_BUDGET, DELETE_QUOTA_SHARE } = await import("@/worker/jobs/purge-connection-logs");
const { JOBS, SCHEDULES } = await import("@/worker/jobs");

const NOW = new Date("2026-10-16T03:15:00Z");
const DAY = 24 * 3_600_000;

/** Every batch is full: the backlog is larger than any budget. */
const endless = () => vi.mocked(deleteConnectionLogsPastPurge).mockImplementation(async (_now, limit) => limit);

beforeEach(() => {
  configured.value = true;
  vi.mocked(deleteConnectionLogsPastPurge).mockReset();
  vi.mocked(oldestConnectionLogPastPurge).mockReset();
  vi.mocked(oldestConnectionLogPastPurge).mockResolvedValue(null);
  vi.mocked(firstDegraded).mockReset();
  vi.mocked(firstDegraded).mockResolvedValue(null);
  vi.mocked(headroom).mockReset();
  vi.mocked(headroom).mockResolvedValue(null);
  vi.mocked(alert).mockClear();
});

describe("purge-connection-logs", () => {
  it("deletes batch after batch until a short one, with the run's date", async () => {
    vi.mocked(deleteConnectionLogsPastPurge).mockResolvedValueOnce(500).mockResolvedValueOnce(500).mockResolvedValueOnce(120);
    expect(await purgeConnectionLogs(NOW)).toEqual({ deleted: 1120, deferred: false });
    expect(vi.mocked(deleteConnectionLogsPastPurge).mock.calls).toEqual([
      [NOW, CONNECTION_LOG_BATCH],
      [NOW, CONNECTION_LOG_BATCH],
      [NOW, CONNECTION_LOG_BATCH],
    ]);
    // The delete quota (and the reads the query bills) is checked before every batch.
    expect(firstDegraded).toHaveBeenCalledTimes(3);
    expect(firstDegraded).toHaveBeenCalledWith(["firestore.deletes", "firestore.reads"]);
    expect(oldestConnectionLogPastPurge).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("stops at the nightly budget and alerts on a backlog older than 3 days", async () => {
    endless();
    vi.mocked(oldestConnectionLogPastPurge).mockResolvedValue(new Date(NOW.getTime() - 4 * DAY));
    expect(await purgeConnectionLogs(NOW)).toEqual({ deleted: CONNECTION_LOG_PURGE_BUDGET, deferred: true });
    expect(deleteConnectionLogsPastPurge).toHaveBeenCalledTimes(CONNECTION_LOG_PURGE_BUDGET / CONNECTION_LOG_BATCH);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: "Purge en retard : connectionLogs" }));
    expect(vi.mocked(alert).mock.calls[0]?.[0].body).toContain("2026-10-12");
  });

  it("does not alert on a recent backlog", async () => {
    endless();
    vi.mocked(oldestConnectionLogPastPurge).mockResolvedValue(new Date(NOW.getTime() - 2 * DAY));
    expect((await purgeConnectionLogs(NOW)).deferred).toBe(true);
    expect(oldestConnectionLogPastPurge).toHaveBeenCalledWith(NOW);
    expect(alert).not.toHaveBeenCalled();
  });

  it("never goes past 90 % of the daily delete quota", async () => {
    endless();
    vi.mocked(headroom).mockResolvedValue(1_200);
    expect(await purgeConnectionLogs(NOW)).toEqual({ deleted: 1_200, deferred: true });
    expect(headroom).toHaveBeenCalledWith("firestore.deletes", DELETE_QUOTA_SHARE);
    expect(vi.mocked(deleteConnectionLogsPastPurge).mock.calls.map(([, limit]) => limit)).toEqual([500, 500, 200]);
    // No headroom left (retention-purge used it): nothing is queried.
    vi.mocked(deleteConnectionLogsPastPurge).mockClear();
    vi.mocked(headroom).mockResolvedValue(0);
    expect(await purgeConnectionLogs(NOW)).toEqual({ deleted: 0, deferred: true });
    expect(deleteConnectionLogsPastPurge).not.toHaveBeenCalled();
  });

  it("defers when deletes or reads are degraded, before or during the run", async () => {
    endless();
    vi.mocked(firstDegraded).mockResolvedValue("firestore.deletes");
    expect(await purgeConnectionLogs(NOW)).toEqual({ deleted: 0, deferred: true });
    expect(deleteConnectionLogsPastPurge).not.toHaveBeenCalled();

    vi.mocked(firstDegraded).mockReset();
    vi.mocked(firstDegraded).mockResolvedValueOnce(null).mockResolvedValueOnce("firestore.reads");
    expect(await purgeConnectionLogs(NOW)).toEqual({ deleted: CONNECTION_LOG_BATCH, deferred: true });
    expect(deleteConnectionLogsPastPurge).toHaveBeenCalledTimes(1);
  });

  it("keeps its result when the backlog check fails", async () => {
    endless();
    vi.mocked(oldestConnectionLogPastPurge).mockRejectedValue(new Error("RESOURCE_EXHAUSTED"));
    expect(await purgeConnectionLogs(NOW)).toEqual({ deleted: CONNECTION_LOG_PURGE_BUDGET, deferred: true });
    expect(alert).not.toHaveBeenCalled();
  });

  it("does nothing without Firebase", async () => {
    configured.value = false;
    expect(await purgeConnectionLogs(NOW)).toEqual({ deleted: 0, deferred: false });
    expect(deleteConnectionLogsPastPurge).not.toHaveBeenCalled();
  });

  it("is a nightly job of the system queue in a free slot, after retention-purge and before the backup", () => {
    expect(JOBS["purge-connection-logs"]).toBeTypeOf("function");
    expect(SCHEDULES["purge-connection-logs-nightly"]).toEqual({ pattern: "15 3 * * *", job: "purge-connection-logs" });
    const patterns = Object.values(SCHEDULES).map((schedule) => schedule.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
    const minuteOfDay = (pattern: string) => {
      const [minute, hour] = pattern.split(" ");
      return Number(hour) * 60 + Number(minute);
    };
    expect(minuteOfDay(SCHEDULES["purge-connection-logs-nightly"].pattern)).toBeGreaterThan(minuteOfDay(SCHEDULES["retention-purge-nightly"].pattern));
    expect(minuteOfDay(SCHEDULES["purge-connection-logs-nightly"].pattern)).toBeLessThan(minuteOfDay(SCHEDULES["backup-firestore-nightly"].pattern));
    // Nor at the minute of an hourly job.
    const hourlyMinutes = patterns.filter((pattern) => pattern.split(" ")[1] === "*").map((pattern) => pattern.split(" ")[0]);
    expect(hourlyMinutes.length).toBeGreaterThan(0);
    expect(hourlyMinutes).not.toContain("15");
  });
});
