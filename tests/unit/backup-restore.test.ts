import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bucketSource, parseListPage } from "@/lib/backup/bucket-source";
import { encryptAge, generateIdentity, identityToRecipient } from "@/lib/backup/crypto";
import { encodeValue } from "@/lib/backup/encode";
import { manifestKey, partKey, sealPart, type BackupMode } from "@/lib/backup/parts";
import { applyRestore, checkRestore, directorySource, parseManifest, planRestore, RestoreError, type BackupSource, type RestoreTarget } from "@/lib/backup/restore";

// Restore planning and checks (D17) on synthetic backups encrypted with an in-memory key pair:
// manifest verification, the newest version of a document wins whatever the file order, filters,
// batches of 500. The emulator round trip is in tests/api/backup/restore.test.ts.

let identity: string;
let recipient: string;

beforeAll(async () => {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
});

interface PartSpec {
  mode: BackupMode;
  collection: string;
  docs: { p: string; d?: Record<string, unknown>; u: string | null }[];
  part?: number | null;
}

class MemorySource implements BackupSource {
  readonly label = "memory";
  readonly objects = new Map<string, Uint8Array>();
  async list() {
    return [...this.objects.keys()];
  }
  async read(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error("missing");
    return body;
  }
}

const line = (doc: PartSpec["docs"][number]) => JSON.stringify({ p: doc.p, d: doc.d ?? {}, u: doc.u });

/** Writes one date of a backup the way runBackup does; returns the manifest object. */
async function addDate(source: MemorySource, date: string, specs: PartSpec[], options: { manifest?: boolean; tamper?: (manifest: { parts: Record<string, unknown>[] }) => void } = {}) {
  const parts: Record<string, unknown>[] = [];
  for (const spec of specs) {
    const sealed = await sealPart(spec.docs.map(line), recipient);
    const key = partKey(date, spec.mode, spec.collection, spec.part ?? null);
    source.objects.set(key, sealed.body);
    parts.push({ key, mode: spec.mode, collection: spec.collection, part: spec.part ?? null, docs: sealed.docs, plainBytes: sealed.plainBytes, gzipBytes: sealed.gzipBytes, bytes: sealed.bytes, sha256: sealed.sha256 });
  }
  const manifest = { version: 1, date, parts };
  options.tamper?.(manifest);
  if (options.manifest !== false) source.objects.set(manifestKey(date), await encryptAge(Buffer.from(JSON.stringify(manifest)), recipient));
  return manifest;
}

function fakeTarget() {
  const commits: { path: string; data: Record<string, unknown> }[][] = [];
  const target = {
    doc: (path: string) => ({ path }),
    batch: () => {
      const sets: { path: string; data: Record<string, unknown> }[] = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          sets.push({ path: ref.path, data });
        },
        commit: async () => {
          commits.push(sets);
        },
      };
    },
  } as unknown as RestoreTarget;
  const written = () => new Map(commits.flat().map((entry) => [entry.path, entry.data]));
  return { target, commits, written };
}

async function restoreAll(source: BackupSource, options: Parameters<typeof planRestore>[2] = {}) {
  const plan = await planRestore(source, identity, options);
  const check = await checkRestore(source, plan, identity);
  const { target, commits, written } = fakeTarget();
  const result = await applyRestore(source, plan, check, identity, target);
  return { plan, check, result, commits, written: written() };
}

describe("choice of the version to restore", () => {
  it("writes the newest version of each document, whatever the file order", async () => {
    const source = new MemorySource();
    // Day 1 rolling full captured X after its last change; day 2's incremental holds an older X.
    await addDate(source, "2026-10-14", [
      { mode: "incremental", collection: "listings", docs: [{ p: "listings/x", d: { v: "x1" }, u: "2026-10-13T10:00:00.000Z" }] },
      { mode: "full", collection: "listings", docs: [{ p: "listings/y", d: { v: "y1" }, u: "2026-10-13T09:00:00.000Z" }] },
    ]);
    await addDate(source, "2026-10-15", [
      { mode: "full", collection: "listings", docs: [{ p: "listings/x", d: { v: "x3" }, u: "2026-10-15T02:00:00.000Z" }] },
      { mode: "incremental", collection: "listings", docs: [{ p: "listings/y", d: { v: "y2" }, u: "2026-10-15T01:00:00.000Z" }] },
    ]);
    await addDate(source, "2026-10-16", [
      { mode: "incremental", collection: "listings", docs: [{ p: "listings/x", d: { v: "x2" }, u: "2026-10-14T12:00:00.000Z" }] },
      { mode: "full", collection: "users", docs: [{ p: "users/u1", d: { name: "Amina" }, u: "2026-10-16T03:00:00.000Z" }] },
    ]);
    const { check, result, written } = await restoreAll(source);
    expect(check.lines).toBe(6);
    expect(check.documents).toBe(3);
    expect(check.byCollection).toEqual({ listings: 2, users: 1 });
    expect(result).toEqual({ writes: 3, batches: 1 });
    expect(written.get("listings/x")).toEqual({ v: "x3" });
    expect(written.get("listings/y")).toEqual({ v: "y2" });
    expect(written.get("users/u1")).toEqual({ name: "Amina" });
  });

  it("prefers the later capture when the update times are equal or unknown", async () => {
    const source = new MemorySource();
    await addDate(source, "2026-10-15", [{ mode: "full", collection: "auditLogs", docs: [{ p: "auditLogs/a", d: { n: 1 }, u: null }, { p: "auditLogs/b", d: { n: 1 }, u: "2026-10-10T00:00:00.000Z" }] }]);
    await addDate(source, "2026-10-16", [{ mode: "full", collection: "auditLogs", docs: [{ p: "auditLogs/a", d: { n: 2 }, u: null }, { p: "auditLogs/b", d: { n: 2 }, u: "2026-10-10T00:00:00.000Z" }] }]);
    const { written } = await restoreAll(source);
    expect(written.get("auditLogs/a")).toEqual({ n: 2 });
    expect(written.get("auditLogs/b")).toEqual({ n: 2 });
  });

  it("decodes Firestore types into the target", async () => {
    const source = new MemorySource();
    const d = encodeValue({ at: new Timestamp(1_792_000_000, 5_000), raw: Buffer.from([1, 2]), nested: { list: [1, { deep: true }] } }) as Record<string, unknown>;
    // Top-level fields are never tags (encodeDocument does not wrap the document itself).
    d["__t"] = "user data";
    await addDate(source, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", d, u: null }] }]);
    const data = (await restoreAll(source)).written.get("users/u1") as Record<string, unknown>;
    expect(data["__t"]).toBe("user data");
    expect((data["at"] as Timestamp).isEqual(new Timestamp(1_792_000_000, 5_000))).toBe(true);
    expect([...(data["raw"] as Buffer)]).toEqual([1, 2]);
    expect(data["nested"]).toEqual({ list: [1, { deep: true }] });
  });

  it("commits batches of 500", async () => {
    const source = new MemorySource();
    const docs = Array.from({ length: 1_203 }, (_, index) => ({ p: `searchOutbox/l${index}`, u: null }));
    await addDate(source, "2026-10-16", [
      { mode: "full", collection: "searchOutbox", part: 1, docs: docs.slice(0, 700) },
      { mode: "full", collection: "searchOutbox", part: 2, docs: docs.slice(700) },
    ]);
    const { result, commits } = await restoreAll(source);
    expect(result).toEqual({ writes: 1_203, batches: 3 });
    expect(commits.map((batch) => batch.length)).toEqual([500, 500, 203]);
  });
});

describe("manifest verification", () => {
  it("refuses a part listed in the manifest but missing", async () => {
    const source = new MemorySource();
    await addDate(source, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }]);
    source.objects.delete(partKey("2026-10-16", "full", "users", null));
    await expect(planRestore(source, identity)).rejects.toThrow(/listed in the manifest of 2026-10-16 but missing/);
  });

  it("refuses a part whose hash or document count differs from the manifest", async () => {
    const hash = new MemorySource();
    await addDate(hash, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }], { tamper: (manifest) => void ((manifest.parts[0] as Record<string, unknown>)["sha256"] = "0".repeat(64)) });
    const plan = await planRestore(hash, identity);
    await expect(checkRestore(hash, plan, identity)).rejects.toThrow(/does not match its manifest/);

    const count = new MemorySource();
    await addDate(count, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }], { tamper: (manifest) => void ((manifest.parts[0] as Record<string, unknown>)["docs"] = 2) });
    await expect(checkRestore(count, await planRestore(count, identity), identity)).rejects.toThrow(/documents 1\/2/);
  });

  it("ignores parts the manifest does not list, and restores a date without manifest with a warning", async () => {
    const source = new MemorySource();
    await addDate(source, "2026-10-15", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }]);
    const stale = await sealPart([line({ p: "users/stale", u: null })], recipient);
    source.objects.set(partKey("2026-10-15", "full", "users", 3), stale.body);
    await addDate(source, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u2", u: null }] }], { manifest: false });
    const { plan, written } = await restoreAll(source);
    expect(plan.verifiedDates).toEqual(["2026-10-15"]);
    expect(plan.dates).toEqual(["2026-10-15", "2026-10-16"]);
    expect(plan.warnings).toEqual([expect.stringContaining("2026-10-15: 1 part(s) not in the manifest ignored"), expect.stringContaining("2026-10-16: no manifest")]);
    expect([...written.keys()].sort()).toEqual(["users/u1", "users/u2"]);
  });

  it("refuses a malformed manifest", () => {
    expect(() => parseManifest("{", "2026-10-16")).toThrow(/not JSON/);
    expect(() => parseManifest(JSON.stringify({ version: 2, date: "2026-10-16", parts: [] }), "2026-10-16")).toThrow(/version 1/);
    expect(() => parseManifest(JSON.stringify({ version: 1, date: "2026-10-15", parts: [] }), "2026-10-16")).toThrow(/version 1/);
    const part = { key: partKey("2026-10-16", "full", "users", null), docs: 1, plainBytes: 10, sha256: "a".repeat(64) };
    expect(parseManifest(JSON.stringify({ version: 1, date: "2026-10-16", parts: [part] }), "2026-10-16")).toEqual([{ logical: "2026-10-16/full/users.ndjson.gz.age", collection: "users", docs: 1, plainBytes: 10, sha256: "a".repeat(64) }]);
    for (const bad of [{ ...part, key: partKey("2026-10-15", "full", "users", null) }, { ...part, docs: -1 }, { ...part, sha256: "xyz" }, { ...part, key: "notes.txt" }, null]) {
      expect(() => parseManifest(JSON.stringify({ version: 1, date: "2026-10-16", parts: [bad] }), "2026-10-16")).toThrow(/part 0 is malformed/);
    }
  });

  it("refuses duplicates in the source", async () => {
    const source = new MemorySource();
    await addDate(source, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }]);
    const body = source.objects.get(partKey("2026-10-16", "full", "users", null)) as Uint8Array;
    source.objects.set("copy/2026-10-16/full/users.ndjson.gz.age", body);
    await expect(planRestore(source, identity)).rejects.toThrow(/appears twice/);
    source.objects.delete("copy/2026-10-16/full/users.ndjson.gz.age");
    source.objects.set("copy/2026-10-16/manifest.json.age", source.objects.get(manifestKey("2026-10-16")) as Uint8Array);
    await expect(planRestore(source, identity)).rejects.toThrow(/two manifests/);
  });
});

describe("restore options and errors", () => {
  it("stops at --until and keeps only --collections", async () => {
    const source = new MemorySource();
    await addDate(source, "2026-10-15", [
      { mode: "full", collection: "users", docs: [{ p: "users/u1", d: { v: 1 }, u: "2026-10-15T00:00:00.000Z" }] },
      { mode: "full", collection: "listings", docs: [{ p: "listings/l1", u: null }] },
    ]);
    await addDate(source, "2026-10-16", [{ mode: "incremental", collection: "users", docs: [{ p: "users/u1", d: { v: 2 }, u: "2026-10-16T00:00:00.000Z" }] }]);
    const until = await restoreAll(source, { until: "2026-10-15", collections: ["users", "staff"] });
    expect(until.plan.dates).toEqual(["2026-10-15"]);
    expect([...until.written.entries()]).toEqual([["users/u1", { v: 1 }]]);
    expect(until.plan.warnings).toEqual(['collection "staff" is in no backup part']);
    await expect(planRestore(source, identity, { until: "16/10/2026" })).rejects.toBeInstanceOf(RestoreError);
  });

  it("names the file and suggests the identity when decryption fails", async () => {
    const source = new MemorySource();
    await addDate(source, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }], { manifest: false });
    const other = await generateIdentity();
    const plan = await planRestore(source, other);
    await expect(checkRestore(source, plan, other)).rejects.toThrow(/users\.ndjson\.gz\.age: cannot be decrypted or decompressed, wrong identity\?/);
    await addDate(source, "2026-10-17", [], {});
    await expect(planRestore(source, other)).rejects.toThrow(/manifest\.json\.age: cannot be decrypted, wrong identity\?/);
  });

  it("refuses malformed lines and documents filed under another collection", async () => {
    const bad = new MemorySource();
    bad.objects.set(partKey("2026-10-16", "full", "users", null), (await sealPart([line({ p: "users/u1", u: null }), '{"p":"users/u2","d":{"x":{"__t":"geo"}},"u":null}'], recipient)).body);
    await expect(checkRestore(bad, await planRestore(bad, identity), identity)).rejects.toThrow(/users\.ndjson\.gz\.age line 2: geo\.lat/);
    const misfiled = new MemorySource();
    misfiled.objects.set(partKey("2026-10-16", "full", "users", null), (await sealPart([line({ p: "listings/l1", u: null })], recipient)).body);
    await expect(checkRestore(misfiled, await planRestore(misfiled, identity), identity)).rejects.toThrow(/document of another collection/);
  });

  it("refuses to write a part that changed after the check", async () => {
    const source = new MemorySource();
    await addDate(source, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }], { manifest: false });
    const plan = await planRestore(source, identity);
    const check = await checkRestore(source, plan, identity);
    source.objects.set(partKey("2026-10-16", "full", "users", null), (await sealPart([line({ p: "users/u9", u: null })], recipient)).body);
    await expect(applyRestore(source, plan, check, identity, fakeTarget().target)).rejects.toThrow(/changed since it was checked/);
  });
});

describe("sources", () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads a downloaded folder, wherever the date trees sit", async () => {
    dir = await mkdtemp(join(tmpdir(), "joutiya-backup-"));
    const memory = new MemorySource();
    await addDate(memory, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }]);
    for (const [key, body] of memory.objects) {
      const path = join(dir, "download", key);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, body);
    }
    await writeFile(join(dir, "README.txt"), "not a backup");
    const source = directorySource(dir);
    expect((await source.list()).sort()).toEqual(["README.txt", "download/backups/2026-10-16/full/users.ndjson.gz.age", "download/backups/2026-10-16/manifest.json.age"]);
    const { plan, written } = await restoreAll(source);
    expect(plan.verifiedDates).toEqual(["2026-10-16"]);
    expect([...written.keys()]).toEqual(["users/u1"]);
    await expect(source.read("../../etc/passwd")).rejects.toThrow(/outside/);
  });

  it("lists and reads the private bucket through signed S3 calls", async () => {
    const memory = new MemorySource();
    await addDate(memory, "2026-10-16", [{ mode: "full", collection: "users", docs: [{ p: "users/u1", u: null }] }]);
    const keys = [...memory.objects.keys()].sort();
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
      if (url.searchParams.get("list-type") === "2") {
        expect(url.pathname).toBe("/joutiya-prod-private");
        expect(url.searchParams.get("prefix")).toBe("backups/");
        const first = !url.searchParams.has("continuation-token");
        const page = first ? keys.slice(0, 1) : keys.slice(1);
        const xml = `<ListBucketResult>${page.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}<IsTruncated>${first}</IsTruncated>${first ? "<NextContinuationToken>t&amp;1</NextContinuationToken>" : ""}</ListBucketResult>`;
        if (!first) expect(url.searchParams.get("continuation-token")).toBe("t&1");
        return new Response(xml, { status: 200 });
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/joutiya-prod-private\//, ""));
      const body = memory.objects.get(key);
      return body ? new Response(Buffer.from(body), { status: 200 }) : new Response("", { status: 404 });
    });
    const source = bucketSource({ endpoint: "https://acc.eu.r2.cloudflarestorage.com/", accessKeyId: "AKIDTEST", secretAccessKey: "SECRET-VALUE", bucket: "joutiya-prod-private", fetch: fetchMock as unknown as typeof fetch });
    expect((await source.list()).sort()).toEqual(keys);
    const { written } = await restoreAll(source);
    expect([...written.keys()]).toEqual(["users/u1"]);
    const failure = await source.read("backups/2026-10-16/full/missing.ndjson.gz.age").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("GET backups/2026-10-16/full/missing.ndjson.gz.age on bucket joutiya-prod-private failed with HTTP 404");
    expect((failure as Error).message).not.toContain("SECRET-VALUE");
  });

  it("parses ListObjectsV2 pages", () => {
    expect(parseListPage("<ListBucketResult><Contents><Key>backups/a&amp;b</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({ keys: ["backups/a&b"], next: null });
    expect(parseListPage("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>abc</NextContinuationToken></ListBucketResult>")).toEqual({ keys: [], next: "abc" });
    expect(() => bucketSource({ endpoint: "http://insecure", accessKeyId: "a", secretAccessKey: "b", bucket: "c" })).toThrow(/https/);
  });
});
