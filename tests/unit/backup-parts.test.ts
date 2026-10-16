import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { AgeRecipientError, decryptAge, encryptAge, generateIdentity, identityToRecipient, isAgeRecipient, parseAgeIdentityFile } from "@/lib/backup/crypto";
import { PartBuilder, manifestKey, openPart, parseBackupKey, partKey, sealPart } from "@/lib/backup/parts";

// Parts of a backup (D17): NDJSON -> gzip -> age with a key pair generated in memory (nothing on
// disk, nothing committed), limits of a part, object keys.

let identity: string;
let recipient: string;

beforeAll(async () => {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
});

describe("age", () => {
  it("encrypts for a recipient and decrypts with its identity only", async () => {
    expect(isAgeRecipient(recipient)).toBe(true);
    const sealed = await encryptAge(Buffer.from("secret"), recipient);
    expect(Buffer.from(sealed).toString("latin1")).toContain("age-encryption.org/v1");
    expect(Buffer.from(sealed).includes(Buffer.from("secret"))).toBe(false);
    expect(Buffer.from(await decryptAge(sealed, identity)).toString()).toBe("secret");
    await expect(decryptAge(sealed, await generateIdentity())).rejects.toThrow();
  });

  it("refuses anything but an X25519 recipient before touching the data", async () => {
    for (const value of [undefined, "", "age1", `${recipient}x`, recipient.toUpperCase(), identity, "age1pq1" + "q".repeat(60)]) {
      expect(isAgeRecipient(value)).toBe(false);
    }
    await expect(encryptAge(Buffer.from("x"), "not-a-key")).rejects.toBeInstanceOf(AgeRecipientError);
  });

  it("reads the secret key of an age-keygen file and nothing else", () => {
    const file = `# created: 2026-10-16T09:00:00+02:00\n# public key: ${recipient}\n${identity}\n`;
    expect(parseAgeIdentityFile(file)).toBe(identity);
    expect(parseAgeIdentityFile(`\r\n  ${identity}  \r\n`)).toBe(identity);
    for (const bad of ["", "# only comments\n", `${identity}\n${identity}\n`, "AGE-SECRET-KEY-1abc\n", recipient]) {
      expect(() => parseAgeIdentityFile(bad)).toThrow(/exactly one AGE-SECRET-KEY-1/);
    }
    // The message never carries the file content.
    try {
      parseAgeIdentityFile(`${identity}\n${identity}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(identity);
    }
  });
});

describe("sealPart / openPart", () => {
  it("compresses, encrypts and opens back the exact NDJSON with its hash", async () => {
    const lines = Array.from({ length: 300 }, (_, index) => JSON.stringify({ p: `listings/l${index}`, d: { title: "Vélo tout terrain ".repeat(5), index }, u: null }));
    const part = await sealPart(lines, recipient);
    const plain = Buffer.from(`${lines.join("\n")}\n`);
    expect(part.docs).toBe(300);
    expect(part.plainBytes).toBe(plain.byteLength);
    expect(part.gzipBytes).toBeLessThan(part.plainBytes);
    expect(part.bytes).toBe(part.body.byteLength);
    expect(part.sha256).toBe(createHash("sha256").update(plain).digest("hex"));
    // No plaintext in what is stored.
    expect(Buffer.from(part.body).includes(Buffer.from("listings/l1"))).toBe(false);
    expect(gunzipSync(await decryptAge(part.body, identity)).equals(plain)).toBe(true);

    const opened = await openPart(part.body, identity);
    expect(opened.lines).toEqual(lines);
    expect(opened.sha256).toBe(part.sha256);
    expect(opened.plainBytes).toBe(part.plainBytes);
  });

  it("does not open with another identity", async () => {
    const part = await sealPart(['{"p":"a/b","d":{},"u":null}'], recipient);
    await expect(openPart(part.body, await generateIdentity())).rejects.toThrow();
  });

  it("refuses an invalid recipient", async () => {
    await expect(sealPart(["{}"], "age1nope")).rejects.toBeInstanceOf(AgeRecipientError);
  });
});

describe("PartBuilder", () => {
  it("cuts a part at maxDocs and at maxBytes, never dropping a line", () => {
    const builder = new PartBuilder({ maxDocs: 3, maxBytes: 1_000 });
    const parts: string[][] = [];
    for (let index = 0; index < 7; index += 1) {
      const full = builder.push(`line-${index}`);
      if (full) parts.push(full);
    }
    parts.push(builder.flush());
    expect(parts).toEqual([["line-0", "line-1", "line-2"], ["line-3", "line-4", "line-5"], ["line-6"]]);
    expect(builder.flush()).toEqual([]);

    const bytes = new PartBuilder({ maxDocs: 100, maxBytes: 10 });
    expect(bytes.push("aaaa")).toBeNull(); // 5 bytes with "\n"
    expect(bytes.push("bbbb")).toBeNull(); // 10
    expect(bytes.push("c")).toEqual(["aaaa", "bbbb"]);
    expect(bytes.pending).toEqual({ docs: 1, bytes: 2 });
  });

  it("gives an oversized line a part of its own", () => {
    const builder = new PartBuilder({ maxDocs: 10, maxBytes: 8 });
    expect(builder.push("x".repeat(50))).toBeNull();
    expect(builder.push("y")).toEqual(["x".repeat(50)]);
    expect(builder.flush()).toEqual(["y"]);
  });

  it("refuses non-positive limits", () => {
    expect(() => new PartBuilder({ maxDocs: 0, maxBytes: 1 })).toThrow(RangeError);
    expect(() => new PartBuilder({ maxDocs: 1, maxBytes: Number.NaN })).toThrow(RangeError);
  });
});

describe("object keys", () => {
  it("builds the D17 layout", () => {
    expect(partKey("2026-10-16", "full", "users", null)).toBe("backups/2026-10-16/full/users.ndjson.gz.age");
    expect(partKey("2026-10-16", "incremental", "listings", 2)).toBe("backups/2026-10-16/incremental/listings-2.ndjson.gz.age");
    expect(manifestKey("2026-10-16")).toBe("backups/2026-10-16/manifest.json.age");
  });

  it("parses keys and downloaded paths to the same logical key", () => {
    expect(parseBackupKey("backups/2026-10-16/full/users.ndjson.gz.age")).toEqual({ kind: "part", date: "2026-10-16", mode: "full", collection: "users", part: null, logical: "2026-10-16/full/users.ndjson.gz.age" });
    expect(parseBackupKey("2026-10-16/incremental/moderationDecisions-12.ndjson.gz.age")).toMatchObject({ collection: "moderationDecisions", part: 12, logical: "2026-10-16/incremental/moderationDecisions-12.ndjson.gz.age" });
    expect(parseBackupKey("dl\\backups\\2026-10-16\\full\\private.ndjson.gz.age")).toMatchObject({ kind: "part", collection: "private" });
    expect(parseBackupKey("x/backups/2026-10-16/manifest.json.age")).toEqual({ kind: "manifest", date: "2026-10-16", logical: "2026-10-16/manifest.json.age" });
    for (const key of ["backups/2026-10-16/full/users.ndjson.gz", "backups/2026-10-16/other/users.ndjson.gz.age", "backups/16-10-2026/full/users.ndjson.gz.age", "backups/2026-10-16/full/users-0.ndjson.gz.age", "backups/2026-10-16/full/.ndjson.gz.age", "notes.txt"]) {
      expect(parseBackupKey(key), key).toBeNull();
    }
  });
});
