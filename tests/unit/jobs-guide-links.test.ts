import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

// guide-links (Monday 06:10 UTC, design guide-demarches G4): every source fetched once (plus one
// retry when nothing answered), the state written in one document, one info alert listing only the
// sources newly flagged.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => null) }));
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => true, isFirebaseConfigured: () => true, db: vi.fn() }));

const { alert } = await import("@/lib/alert");
const { GUIDE_SOURCE_IDS, GUIDE_SOURCES } = await import("@/content/guide");
const { checkGuideLinks } = await import("@/worker/jobs/guide-links");
const { JOBS, SCHEDULES } = await import("@/worker/jobs");

function fakeDb() {
  const store: { data?: Record<string, unknown> } = {};
  const doc = { get: vi.fn(async () => ({ data: () => store.data })), set: vi.fn(async (value: Record<string, unknown>) => void (store.data = structuredClone(value))) };
  const firestore = { collection: vi.fn(() => ({ doc: vi.fn(() => doc) })) } as unknown as Firestore;
  return { firestore, store, doc };
}

const okPage = (url: string) => ({ status: 200, finalUrl: url, contentType: "text/html", body: `<title>${url}</title><p>Page officielle de la démarche</p>`, fingerprint: { simhash: "0123456789abcdef", sha256: "a".repeat(64) } });

beforeEach(() => vi.mocked(alert).mockClear());

describe("guide-links", () => {
  it("is scheduled weekly and registered", () => {
    expect(SCHEDULES["guide-links-weekly"]).toEqual({ pattern: "10 6 * * 1", job: "guide-links" });
    expect(JOBS["guide-links"]).toBeTypeOf("function");
  });

  it("checks every source, retries a silent one, stores the state and alerts only new flags", async () => {
    const { firestore, store, doc } = fakeDb();
    const broken = GUIDE_SOURCES["onousc-logement"].url;
    const silent = GUIDE_SOURCES.cnss.url;
    const fetchPage = vi.fn(async (url: string) => {
      if (url === broken) return { status: 404, finalUrl: url, contentType: "text/html", body: "<title>Not found</title>" };
      if (url === silent) return { status: null, finalUrl: url, contentType: "", body: "", error: "délai dépassé" };
      return okPage(url);
    });

    const first = await checkGuideLinks(new Date("2026-11-02T06:10:00Z"), { db: firestore, fetchPage });
    expect(first).toMatchObject({ checked: GUIDE_SOURCE_IDS.length, ok: GUIDE_SOURCE_IDS.length - 2 });
    // One call per source, two for the one that never answered.
    expect(fetchPage).toHaveBeenCalledTimes(GUIDE_SOURCE_IDS.length + 1);
    expect(doc.set).toHaveBeenCalledTimes(1);
    const links = (store.data as { links: Record<string, { outcome: string; streak: number }> }).links;
    expect(links["onousc-logement"]).toMatchObject({ outcome: "broken", streak: 1 });
    expect(links["cnss"]).toMatchObject({ outcome: "unreachable" });
    // First run: the unconfirmed CNSS never answered.
    expect(first?.newlyFlagged).toEqual(["cnss (jamais vu en ligne)"]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alert).mock.calls[0]![0]).toMatchObject({ severity: "info", title: "Guide des démarches : liens à vérifier" });

    vi.mocked(alert).mockClear();
    const second = await checkGuideLinks(new Date("2026-11-09T06:10:00Z"), { db: firestore, fetchPage });
    expect(second?.newlyFlagged).toEqual(["onousc-logement (lien en échec)"]);
    expect(alert).toHaveBeenCalledTimes(1);

    vi.mocked(alert).mockClear();
    const third = await checkGuideLinks(new Date("2026-11-16T06:10:00Z"), { db: firestore, fetchPage });
    expect(third?.newlyFlagged).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });
});
