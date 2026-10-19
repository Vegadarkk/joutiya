import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportRecord } from "@/lib/reports/repository";

// report-sla-sweep (design D12, every 10 minutes): open or in-review P0 reports past their 1-hour
// target get one more P0 alert, "P0 en retard {id}", once per report (SET NX in valkey-queue; an
// in-process marker without Valkey, failing open when Valkey errors). One Firestore query reads the
// overdue P0 reports only; the alert body carries no personal data. Firestore is a query fake.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false), consume: vi.fn(async () => ({ level: "ok" })) }));
vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => false, valkey: vi.fn() }));

interface QueryCall {
  where: [string, string, unknown][];
  orderBy: [string, string][];
  limit?: number;
}
const firestore = { configured: true, docs: [] as ReportRecord[], calls: [] as QueryCall[] };
vi.mock("@/lib/firebase/admin", () => ({
  isFirestoreConfigured: () => firestore.configured,
  isFirebaseConfigured: () => firestore.configured,
  db: () => ({
    collection: (name: string) => {
      if (name !== "reports") throw new Error(`unexpected collection ${name}`);
      const call: QueryCall = { where: [], orderBy: [] };
      firestore.calls.push(call);
      const query = {
        where: (field: string, op: string, value: unknown) => (call.where.push([field, op, value]), query),
        orderBy: (field: string, direction: string) => (call.orderBy.push([field, direction]), query),
        limit: (count: number) => ((call.limit = count), query),
        get: async () => ({ size: firestore.docs.length, docs: firestore.docs.map((record) => ({ record })) }),
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/reports/repository", () => ({ OPEN_STATUSES: ["open", "in_review"], reportFromSnapshot: (snapshot: { record: ReportRecord }) => snapshot.record }));

const { Timestamp } = await import("firebase-admin/firestore");
const { alert } = await import("@/lib/alert");
const { isDegraded } = await import("@/lib/quota");
const { LATE_MARKER_SECONDS, SLA_SWEEP_LIMIT, lateAlert, lateMarkerKey, resetSlaSweepMemory, sweepReportSla } = await import("@/worker/jobs/report-sla-sweep");

const NOW = new Date("2026-10-16T12:00:00Z");
const MIN = 60_000;

function report(id: string, overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    id,
    target: { type: "listing", id: "abcd2345", ownerUid: "seller-uid-secret" },
    reasonId: "minors",
    priority: "P0",
    explanation: "Texte libre du signaleur avec un numéro 0612345678",
    goodFaith: true,
    source: "user",
    reporter: { uid: "reporter-uid-secret", email: "reporter@example.com", name: "Nadia", locale: "fr", ipPrefixHash: "h", deviceHash: "d", trusted: false },
    hidden: false,
    status: "open",
    slaDueAt: new Date(NOW.getTime() - 25 * MIN),
    createdAt: new Date(NOW.getTime() - 85 * MIN),
    updatedAt: new Date(NOW.getTime() - 85 * MIN),
    purgeAt: new Date("2031-10-16T10:35:00Z"),
    ...overrides,
  } as ReportRecord;
}

/** SET key value EX seconds NX, with a memory. */
function markerStore() {
  const keys = new Map<string, number>();
  return {
    keys,
    failing: false,
    async set(key: string, _value: string, _ex: "EX", seconds: number, _nx: "NX") {
      if (this.failing) throw new Error("connection refused");
      if (keys.has(key)) return null;
      keys.set(key, seconds);
      return "OK";
    },
  };
}

beforeEach(() => {
  firestore.configured = true;
  firestore.docs = [];
  firestore.calls = [];
  resetSlaSweepMemory();
  vi.mocked(alert).mockClear();
  vi.mocked(isDegraded).mockReset().mockResolvedValue(false);
});

describe("report-sla-sweep", () => {
  it("reads only open or in-review P0 reports past due, most overdue first", async () => {
    await sweepReportSla(NOW, { valkey: markerStore() });
    expect(firestore.calls).toHaveLength(1);
    const call = firestore.calls[0]!;
    expect(call.where).toEqual([
      ["status", "in", ["open", "in_review"]],
      ["priority", "==", "P0"],
      ["slaDueAt", "<=", Timestamp.fromDate(NOW)],
    ]);
    expect(call.orderBy).toEqual([["slaDueAt", "asc"]]);
    expect(call.limit).toBe(SLA_SWEEP_LIMIT);
    expect(alert).not.toHaveBeenCalled();
  });

  it("alerts each overdue P0 once, with its own title, then never again", async () => {
    const redis = markerStore();
    firestore.docs = [report("rep1"), report("rep2", { status: "in_review", assignee: "mod-uid", hidden: true, strongSignal: "multi", target: { type: "message", id: "c/m", ownerUid: "x" } })];
    expect(await sweepReportSla(NOW, { valkey: redis })).toEqual({ overdue: 2, alerted: 2, failed: 0 });
    expect(vi.mocked(alert).mock.calls.map(([event]) => event.title)).toEqual(["P0 en retard rep1", "P0 en retard rep2"]);
    expect(redis.keys.get(lateMarkerKey("rep1"))).toBe(LATE_MARKER_SECONDS);
    const second = vi.mocked(alert).mock.calls[1]![0];
    expect(second.severity).toBe("P0");
    expect(second.body).toContain("Cible : message");
    expect(second.body).toContain("en cours d'examen (assigné)");
    expect(second.body).toContain("Signal fort : oui (multi)");
    expect(second.body).toContain("Contenu masqué : oui");
    vi.mocked(alert).mockClear();
    expect(await sweepReportSla(new Date(NOW.getTime() + 10 * MIN), { valkey: redis })).toEqual({ overdue: 2, alerted: 0, failed: 0 });
    expect(alert).not.toHaveBeenCalled();
  });

  it("keeps personal data out of the alert", () => {
    const { title, body } = lateAlert(report("rep1"), NOW);
    expect(title).toBe("P0 en retard rep1");
    for (const secret of ["seller-uid-secret", "reporter-uid-secret", "reporter@example.com", "Nadia", "0612345678", "abcd2345"]) {
      expect(`${title}\n${body}`).not.toContain(secret);
    }
    expect(body).toContain("Motif : minors");
    expect(body).toContain("dépassée de 25 min");
    expect(body).toMatch(/Échéance : 16\/10\/2026 13:35 \(Paris\)/);
  });

  it("without Valkey, alerts once per process; with Valkey failing, alerts rather than stay silent", async () => {
    firestore.docs = [report("rep1")];
    expect(await sweepReportSla(NOW, { valkey: null })).toMatchObject({ alerted: 1 });
    expect(await sweepReportSla(NOW, { valkey: null })).toMatchObject({ alerted: 0 });
    resetSlaSweepMemory();
    const redis = markerStore();
    redis.failing = true;
    expect(await sweepReportSla(NOW, { valkey: redis })).toMatchObject({ alerted: 1 });
  });

  it("does nothing without Firebase or while the read quota is degraded", async () => {
    firestore.docs = [report("rep1")];
    vi.mocked(isDegraded).mockResolvedValue(true);
    expect(await sweepReportSla(NOW, { valkey: markerStore() })).toMatchObject({ stopped: "quota", alerted: 0 });
    firestore.configured = false;
    vi.mocked(isDegraded).mockResolvedValue(false);
    expect(await sweepReportSla(NOW, { valkey: markerStore() })).toMatchObject({ overdue: 0, alerted: 0 });
    expect(firestore.calls).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
  });

  it("counts a failing alert and goes on with the next report", async () => {
    firestore.docs = [report("rep1"), report("rep2")];
    vi.mocked(alert).mockRejectedValueOnce(new Error("boom"));
    expect(await sweepReportSla(NOW, { valkey: markerStore() })).toEqual({ overdue: 2, alerted: 1, failed: 1 });
  });
});
