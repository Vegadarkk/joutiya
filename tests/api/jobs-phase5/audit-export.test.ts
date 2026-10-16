import { Timestamp } from "firebase-admin/firestore";
import { beforeAll, describe, expect, it, vi } from "vitest";

// audit-export (design D23) against the Firestore emulator: one finished UTC day of auditLogs ->
// NDJSON (backup line format) -> gzip -> age, `audit/{date}.ndjson.gz.age` in the private bucket,
// decrypted back with the identity; the cursor (system/auditExport) makes a second run a no-op and
// a later run catch the missed days up; an object already there is never rewritten. The run date
// is in the future so the day holds only this file's entries.

vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));

import { generateIdentity, identityToRecipient } from "@/lib/backup/crypto";
import { parseBackupLine } from "@/lib/backup/encode";
import { openPart } from "@/lib/backup/parts";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { auditExportKey, exportAuditLogs } from "@/worker/jobs/audit-export";

const NOW = new Date("2031-01-02T03:22:00Z");
const RUN = `l5-${Date.now().toString(36)}`;
let identity: string;
let recipient: string;
const store = new MemoryObjectStore();

async function entry(name: string, at: string): Promise<string> {
  const ref = db().collection(COLLECTIONS.auditLogs).doc(`${RUN}-${name}`);
  await ref.set({ actorUid: "system", actorRole: "system", action: `test.${name}`, target: { type: "listing", id: "abcd2345" }, automated: true, at: Timestamp.fromDate(new Date(at)) });
  return ref.id;
}

async function exported(date: string): Promise<{ lines: string[]; actions: string[] }> {
  const body = await store.get("private", auditExportKey(date));
  expect(body, `object for ${date}`).not.toBeNull();
  const { lines } = await openPart(body!, identity);
  return { lines, actions: lines.map((line) => String(parseBackupLine(line).d.action)) };
}

beforeAll(async () => {
  resetServerEnv();
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
  await db().collection(COLLECTIONS.system).doc("auditExport").delete();
  await entry("before", "2030-12-31T23:59:59.999Z");
  await entry("second", "2031-01-01T18:00:00Z");
  await entry("first", "2031-01-01T00:00:00Z");
  await entry("after", "2031-01-02T00:00:00Z");
  await entry("later", "2031-01-04T12:00:00Z");
});

describe("audit-export on the emulator", () => {
  it("exports yesterday's entries only, in time order, encrypted, readable back with the identity", async () => {
    const result = await exportAuditLogs(NOW, { store, recipient });
    expect(result.status).toBe("done");
    expect(result.days).toEqual([expect.objectContaining({ date: "2031-01-01", key: "audit/2031-01-01.ndjson.gz.age", docs: 2, existed: false })]);
    const { lines, actions } = await exported("2031-01-01");
    expect(actions).toEqual(["test.first", "test.second"]);
    const parsed = parseBackupLine(lines[0]!);
    expect(parsed.p).toBe(`auditLogs/${RUN}-first`);
    expect(parsed.d.at).toMatchObject({ __t: "ts" });
    // Never in clear in the bucket.
    const raw = Buffer.from((await store.get("private", auditExportKey("2031-01-01")))!).toString("latin1");
    expect(raw.startsWith("age-encryption.org/v1")).toBe(true);
    expect(raw).not.toContain("test.first");
    expect((await db().collection(COLLECTIONS.system).doc("auditExport").get()).get("through")).toBe("2031-01-01");
  });

  it("a second run the same night does nothing", async () => {
    const puts = store.calls.filter((call) => call.op === "put").length;
    expect(await exportAuditLogs(NOW, { store, recipient })).toEqual({ status: "done", days: [] });
    expect(store.calls.filter((call) => call.op === "put").length).toBe(puts);
  });

  it("catches missed nights up (an empty day still gets its object) and never rewrites an existing object", async () => {
    // 2031-01-03 was written by an earlier run whose cursor write failed.
    store.seed("private", auditExportKey("2031-01-03"), Buffer.from("existing"), { contentType: "application/octet-stream" });
    const result = await exportAuditLogs(new Date("2031-01-05T03:22:00Z"), { store, recipient });
    expect(result.days.map((day) => [day.date, day.docs, day.existed])).toEqual([
      ["2031-01-02", 1, false],
      ["2031-01-03", 0, true],
      ["2031-01-04", 1, false],
    ]);
    expect((await exported("2031-01-02")).actions).toEqual(["test.after"]);
    expect((await exported("2031-01-04")).actions).toEqual(["test.later"]);
    expect((await store.get("private", auditExportKey("2031-01-03")))!.toString()).toBe("existing");
    expect((await db().collection(COLLECTIONS.system).doc("auditExport").get()).get("through")).toBe("2031-01-04");
  });
});
