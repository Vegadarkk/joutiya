import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PastPurgeDoc, PastPurgePage } from "@/lib/db/repositories/retention";

// retention-purge, phase 5 steps (design D22, AF §7 retention table): conversations 12 months after
// the last activity (no legal hold, not frozen; messages, then the evidence of deleted messages,
// then the document once empty), reports (closed), moderationDecisions (no open appeal) and
// authorityRequests (closed) after 5 years, aiDecisions after 12 months (no hold; one grounding a
// decision kept longer follows it), auditLogs (5 years), userBlocks of purged accounts. The
// repository is mocked here; tests/api/jobs-phase5/retention.test.ts runs the real queries.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false), consume: vi.fn(async () => ({ level: "ok" })) }));
vi.mock("@/lib/uploads/storage-gauge", () => ({ recordMediaBytes: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => undefined) }));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => true, isFirebaseConfigured: () => true, db: vi.fn() }));
vi.mock("@/lib/db/repositories/uploads", () => ({ UPLOADS_BY_TARGET_LIMIT: 100, listUploadsByTarget: vi.fn(async () => []), deleteUploadDocument: vi.fn(), updateUpload: vi.fn() }));
vi.mock("@/lib/db/repositories/retention", () => ({
  listListingsPastPurge: vi.fn(),
  purgeListing: vi.fn(),
  deleteJournalPastPurge: vi.fn(),
  oldestPastPurge: vi.fn(),
  listPastPurge: vi.fn(),
  deleteIfPurgeable: vi.fn(),
  readDecisionPurgeAts: vi.fn(),
  setAiDecisionPurgeAt: vi.fn(),
  deleteConversationMessages: vi.fn(),
  deleteOrphanEvidence: vi.fn(),
  deleteConversationIfEmpty: vi.fn(),
  readUserBlocksCursor: vi.fn(),
  writeUserBlocksCursor: vi.fn(),
  purgeOrphanUserBlocks: vi.fn(),
}));

const retention = await import("@/lib/db/repositories/retention");
const { audit } = await import("@/lib/audit");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const job = await import("@/worker/jobs/retention-purge");
const { aiDecisionPurgeable, authorityRequestPurgeable, conversationPurgeable, decisionPurgeable, reportPurgeable, retentionPurge, PURGE_DELETE_BUDGET, MESSAGE_PURGE_BATCH, USER_BLOCKS_SCAN } = job;

const NOW = new Date("2026-10-16T03:00:00Z");
const DAY = 86_400_000;
const PAST = new Date(NOW.getTime() - DAY);
const FUTURE = new Date(NOW.getTime() + DAY);

/** Pages served per collection by listPastPurge (one page each, then empty). */
let pages: Record<string, PastPurgeDoc[]>;

beforeEach(() => {
  for (const fn of Object.values(retention)) if (vi.isMockFunction(fn)) fn.mockReset();
  pages = {};
  vi.mocked(retention.listListingsPastPurge).mockResolvedValue({ listings: [], read: 0 });
  vi.mocked(retention.deleteJournalPastPurge).mockResolvedValue(0);
  vi.mocked(retention.oldestPastPurge).mockResolvedValue(null);
  vi.mocked(retention.listPastPurge).mockImplementation(async (collection): Promise<PastPurgePage> => {
    const docs = pages[collection] ?? [];
    pages[collection] = [];
    return { docs, read: docs.length };
  });
  vi.mocked(retention.deleteIfPurgeable).mockImplementation(async (_collection, ids) => [...ids]);
  vi.mocked(retention.readDecisionPurgeAts).mockResolvedValue(new Map());
  vi.mocked(retention.deleteConversationMessages).mockResolvedValue(0);
  vi.mocked(retention.deleteOrphanEvidence).mockResolvedValue({ deleted: 0, read: 0 });
  vi.mocked(retention.deleteConversationIfEmpty).mockResolvedValue(true);
  vi.mocked(retention.readUserBlocksCursor).mockResolvedValue(null);
  vi.mocked(retention.purgeOrphanUserBlocks).mockResolvedValue({ deleted: 0, read: 0, last: null });
  vi.mocked(audit).mockClear();
});

const run = () => retentionPurge(NOW, { store: new MemoryObjectStore() });

describe("phase 5 purge rules", () => {
  it("conversations: past purgeAt, no legal hold, open", () => {
    const base = { purgeAt: PAST, legalHold: [], status: "open" };
    expect(conversationPurgeable(base, NOW)).toBe(true);
    expect(conversationPurgeable({ ...base, purgeAt: FUTURE }, NOW)).toBe(false);
    expect(conversationPurgeable({ ...base, legalHold: ["report:r1"] }, NOW)).toBe(false);
    expect(conversationPurgeable({ ...base, status: "frozen" }, NOW)).toBe(false);
    // Malformed: kept rather than guessed.
    expect(conversationPurgeable({ ...base, legalHold: undefined }, NOW)).toBe(false);
    expect(conversationPurgeable({ ...base, purgeAt: "2020-01-01" }, NOW)).toBe(false);
  });

  it("reports closed, decisions without an open appeal, authority requests closed", () => {
    expect(reportPurgeable({ purgeAt: PAST, status: "actioned" }, NOW)).toBe(true);
    expect(reportPurgeable({ purgeAt: PAST, status: "dismissed" }, NOW)).toBe(true);
    expect(reportPurgeable({ purgeAt: PAST, status: "open" }, NOW)).toBe(false);
    expect(reportPurgeable({ purgeAt: PAST, status: "in_review" }, NOW)).toBe(false);
    expect(reportPurgeable({ purgeAt: FUTURE, status: "actioned" }, NOW)).toBe(false);
    expect(decisionPurgeable({ purgeAt: PAST }, NOW)).toBe(true);
    expect(decisionPurgeable({ purgeAt: PAST, appeal: { status: "upheld" } }, NOW)).toBe(true);
    expect(decisionPurgeable({ purgeAt: PAST, appeal: { status: "open" } }, NOW)).toBe(false);
    expect(authorityRequestPurgeable({ purgeAt: PAST, status: "closed" }, NOW)).toBe(true);
    expect(authorityRequestPurgeable({ purgeAt: PAST, status: "answered" }, NOW)).toBe(false);
  });

  it("aiDecisions: 12 months without a hold, or as long as the decision they ground", () => {
    const base = { purgeAt: PAST, legalHold: [] };
    expect(aiDecisionPurgeable(base, NOW)).toBe(true);
    expect(aiDecisionPurgeable({ ...base, legalHold: ["report:r1"] }, NOW)).toBe(false);
    expect(aiDecisionPurgeable({ ...base, decisionId: "d1" }, NOW, new Map([["d1", FUTURE]]))).toBe(false);
    expect(aiDecisionPurgeable({ ...base, decisionId: "d1" }, NOW, new Map([["d1", PAST]]))).toBe(true);
    // The decision is gone: nothing to ground any more.
    expect(aiDecisionPurgeable({ ...base, decisionId: "d1" }, NOW, new Map())).toBe(true);
  });
});

describe("retention-purge phase 5 steps", () => {
  it("purges a conversation: messages up to its purgeAt, orphan evidence, then the document", async () => {
    pages.conversations = [
      { id: "conv1", data: { purgeAt: PAST, legalHold: [], status: "open" } },
      { id: "held", data: { purgeAt: PAST, legalHold: ["authority:a1"], status: "frozen" } },
    ];
    vi.mocked(retention.deleteConversationMessages).mockResolvedValueOnce(MESSAGE_PURGE_BATCH).mockResolvedValueOnce(12);
    vi.mocked(retention.deleteOrphanEvidence).mockResolvedValueOnce({ deleted: 2, read: 2 });
    const result = await run();
    expect(result).toMatchObject({ conversations: 1, messages: MESSAGE_PURGE_BATCH + 12, evidence: 2, held: 1, failed: 0 });
    expect(retention.deleteConversationMessages).toHaveBeenCalledWith("conv1", PAST, MESSAGE_PURGE_BATCH);
    expect(retention.deleteConversationMessages).not.toHaveBeenCalledWith("held", expect.anything(), expect.anything());
    // The final check re-applies the rule to the document as it is then.
    const check = vi.mocked(retention.deleteConversationIfEmpty).mock.calls[0]![1];
    expect(check({ purgeAt: PAST, legalHold: [], status: "open" })).toBe(true);
    expect(check({ purgeAt: FUTURE, legalHold: [], status: "open" })).toBe(false);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "retention.purge", target: { type: "collection", id: "conversations" }, reason: "1 documents" }));
  });

  it("a conversation that changed since the query (new message, new hold) is skipped", async () => {
    pages.conversations = [{ id: "conv1", data: { purgeAt: PAST, legalHold: [], status: "open" } }];
    vi.mocked(retention.deleteConversationIfEmpty).mockResolvedValueOnce(false);
    expect(await run()).toMatchObject({ conversations: 0, skipped: 1 });
  });

  it("stops a conversation mid-way at the nightly budget (the rest waits a night)", async () => {
    // contentOps takes all but 100 deletions of the night.
    let left = PURGE_DELETE_BUDGET - 100;
    vi.mocked(retention.deleteJournalPastPurge).mockImplementation(async (collection, _now, limit) => {
      if (collection !== "contentOps") return 0;
      const deleted = Math.min(limit, left);
      left -= deleted;
      return deleted;
    });
    pages.conversations = [{ id: "conv1", data: { purgeAt: PAST, legalHold: [], status: "open" } }];
    vi.mocked(retention.deleteConversationMessages).mockImplementation(async (_cid, _before, limit) => limit);
    const result = await run();
    expect(result.messages).toBe(100);
    expect(result.deferred).toBe(true);
    expect(retention.deleteConversationIfEmpty).not.toHaveBeenCalled();
  });

  it("purges closed reports, decided decisions and closed authority requests in one transaction per page", async () => {
    pages.reports = [
      { id: "r1", data: { purgeAt: PAST, status: "dismissed" } },
      { id: "r2", data: { purgeAt: PAST, status: "open" } },
    ];
    pages.moderationDecisions = [
      { id: "d1", data: { purgeAt: PAST } },
      { id: "d2", data: { purgeAt: PAST, appeal: { status: "open" } } },
    ];
    pages.authorityRequests = [{ id: "a1", data: { purgeAt: PAST, status: "closed" } }];
    const result = await run();
    expect(result).toMatchObject({ reports: 1, decisions: 1, authorityRequests: 1, held: 2 });
    expect(retention.deleteIfPurgeable).toHaveBeenCalledWith("reports", ["r1"], expect.any(Function));
    expect(retention.deleteIfPurgeable).toHaveBeenCalledWith("moderationDecisions", ["d1"], expect.any(Function));
    // A report reopened since the query stays.
    const recheck = vi.mocked(retention.deleteIfPurgeable).mock.calls.find(([collection]) => collection === "reports")![2];
    expect(recheck({ purgeAt: PAST, status: "in_review" })).toBe(false);
  });

  it("keeps an AI proposal grounding a live decision and moves its purgeAt to the decision's", async () => {
    pages.aiDecisions = [
      { id: "ai1", data: { purgeAt: PAST, legalHold: [] } },
      { id: "ai2", data: { purgeAt: PAST, legalHold: [], decisionId: "d1" } },
      { id: "ai3", data: { purgeAt: PAST, legalHold: ["report:r9"] } },
    ];
    vi.mocked(retention.readDecisionPurgeAts).mockResolvedValue(new Map([["d1", FUTURE]]));
    const result = await run();
    expect(retention.readDecisionPurgeAts).toHaveBeenCalledWith(["d1"]);
    expect(result).toMatchObject({ aiDecisions: 1, held: 2 });
    expect(retention.deleteIfPurgeable).toHaveBeenCalledWith("aiDecisions", ["ai1"], expect.any(Function));
    expect(retention.setAiDecisionPurgeAt).toHaveBeenCalledWith("ai2", FUTURE);
    expect(retention.setAiDecisionPurgeAt).toHaveBeenCalledTimes(1);
  });

  it("purges auditLogs past purgeAt as a journal", async () => {
    vi.mocked(retention.deleteJournalPastPurge).mockImplementation(async (collection) => (collection === "auditLogs" ? 7 : 0));
    expect(await run()).toMatchObject({ auditLogs: 7 });
    expect(retention.deleteJournalPastPurge).toHaveBeenCalledWith("auditLogs", NOW, expect.any(Number));
  });

  it("scans userBlocks from the cursor and moves it, back to the start after the last page", async () => {
    vi.mocked(retention.readUserBlocksCursor).mockResolvedValue("uid-100");
    vi.mocked(retention.purgeOrphanUserBlocks).mockResolvedValueOnce({ deleted: 3, read: USER_BLOCKS_SCAN, last: "uid-300" });
    expect(await run()).toMatchObject({ userBlocks: 3 });
    expect(retention.purgeOrphanUserBlocks).toHaveBeenCalledWith("uid-100", USER_BLOCKS_SCAN);
    expect(retention.writeUserBlocksCursor).toHaveBeenLastCalledWith("uid-300", NOW);
    vi.mocked(retention.purgeOrphanUserBlocks).mockResolvedValueOnce({ deleted: 0, read: 12, last: "uid-412" });
    await run();
    expect(retention.writeUserBlocksCursor).toHaveBeenLastCalledWith(null, NOW);
  });

  it("a failing phase 5 step does not stop the others", async () => {
    vi.mocked(retention.listPastPurge).mockRejectedValueOnce(new Error("FAILED_PRECONDITION"));
    pages.reports = [{ id: "r1", data: { purgeAt: PAST, status: "actioned" } }];
    expect(await run()).toMatchObject({ failed: 1, reports: 1 });
  });
});
