import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaStatus } from "@/lib/quota";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/quota", () => ({ readQuotas: vi.fn(async () => []) }));

const set = vi.fn(async () => undefined);
const doc = vi.fn(() => ({ set }));
const collection = vi.fn(() => ({ doc }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ db: () => ({ collection }), isFirestoreConfigured: () => configured.value }));

const { alert } = await import("@/lib/alert");
const { readQuotas } = await import("@/lib/quota");
const { quotaReport } = await import("@/worker/jobs/quota-report");
const { JOBS } = await import("@/worker/jobs");

const STATUS: QuotaStatus[] = [
  { id: "resend.daily", period: "2026-10-15", used: 72, limit: 100, ratio: 0.72, level: "warning" },
  { id: "firestore.reads", period: "2026-10-15", used: 1234, limit: 50_000, ratio: 0.02468, level: "ok" },
];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-16T08:15:00Z") });
  configured.value = true;
  set.mockClear();
  doc.mockClear();
  collection.mockClear();
  vi.mocked(alert).mockClear();
  vi.mocked(readQuotas).mockReset();
  vi.mocked(readQuotas).mockResolvedValue(STATUS);
});

describe("quota-report", () => {
  it("snapshots the closed UTC day into quotaDaily/{date} without an alert", async () => {
    await quotaReport();
    expect(readQuotas).toHaveBeenCalledWith(new Date("2026-10-15T08:15:00Z"));
    expect(collection).toHaveBeenCalledWith("quotaDaily");
    expect(doc).toHaveBeenCalledWith("2026-10-15");
    expect(set).toHaveBeenCalledWith(
      {
        date: "2026-10-15",
        quotas: {
          "resend.daily": { period: "2026-10-15", used: 72, limit: 100, ratio: 0.72, level: "warning" },
          "firestore.reads": { period: "2026-10-15", used: 1234, limit: 50_000, ratio: 0.0247, level: "ok" },
        },
        createdAt: new Date("2026-10-16T08:15:00Z"),
      },
      { merge: true },
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it("raises a P1 when counters could not be read, and skips Firestore when not configured", async () => {
    configured.value = false;
    vi.mocked(readQuotas).mockResolvedValue([...STATUS, { id: "brevo.daily", period: "2026-10-15", used: 0, limit: 300, ratio: 0, level: "unknown" }]);
    await quotaReport();
    expect(set).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith({ severity: "P1", title: "Compteurs de quotas illisibles", body: expect.stringContaining("1 compteurs inconnus pour le 2026-10-15") });
  });

  it("is the nightly job of the system queue", () => {
    expect(JOBS["quota-report"]).toBe(quotaReport);
  });
});
