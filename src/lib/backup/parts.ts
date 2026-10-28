import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { decryptAge, encryptAge } from "./crypto.ts";

// Parts of a backup (D17): NDJSON lines grouped by <= 20 000 documents or <= 16 MiB of NDJSON,
// whichever comes first, then gzip (compress BEFORE encrypting: ciphertext is incompressible),
// then age. One part at a time stays in memory (< 32 MiB). Pure module (no server-only, no "@/").

export const PART_MAX_DOCS = 20_000;
export const PART_MAX_BYTES = 16 * 1024 * 1024;
/** Decompression ceiling of a restore: a part holds <= 16 MiB of NDJSON (one oversized line at most a few MiB more). */
export const PART_MAX_PLAIN_BYTES = 64 * 1024 * 1024;

export type BackupMode = "incremental" | "full";

export interface PartLimits {
  maxDocs: number;
  maxBytes: number;
}

export interface SealedPart {
  docs: number;
  /** NDJSON bytes before compression. */
  plainBytes: number;
  gzipBytes: number;
  /** Encrypted bytes (what is stored). */
  bytes: number;
  /** SHA-256 (hex) of the NDJSON, for a restore to check the decrypted part. */
  sha256: string;
  body: Uint8Array;
}

/**
 * Groups lines into parts. push() returns the lines of the part that became full BEFORE the
 * pushed line (to be sealed), or null; flush() returns what remains (possibly nothing). A single
 * line larger than maxBytes gets a part of its own: the limits bound the memory, never drop a doc.
 */
export class PartBuilder {
  private lines: string[] = [];
  private bytes = 0;
  // No parameter property: plain Node (type stripping) loads this module for the restore script.
  private readonly limits: PartLimits;

  constructor(limits: PartLimits = { maxDocs: PART_MAX_DOCS, maxBytes: PART_MAX_BYTES }) {
    if (!(limits.maxDocs >= 1) || !(limits.maxBytes >= 1)) throw new RangeError("part limits must be positive");
    this.limits = limits;
  }

  push(line: string): string[] | null {
    const size = Buffer.byteLength(line, "utf8") + 1; // the trailing "\n"
    let full: string[] | null = null;
    if (this.lines.length > 0 && (this.lines.length >= this.limits.maxDocs || this.bytes + size > this.limits.maxBytes)) {
      full = this.lines;
      this.lines = [];
      this.bytes = 0;
    }
    this.lines.push(line);
    this.bytes += size;
    return full;
  }

  flush(): string[] {
    const rest = this.lines;
    this.lines = [];
    this.bytes = 0;
    return rest;
  }

  get pending(): { docs: number; bytes: number } {
    return { docs: this.lines.length, bytes: this.bytes };
  }
}

/** NDJSON -> gzip -> age for one recipient. */
export async function sealPart(lines: readonly string[], recipient: string): Promise<SealedPart> {
  const plain = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  const gz = gzipSync(plain, { level: 6 });
  const body = await encryptAge(gz, recipient);
  return {
    docs: lines.length,
    plainBytes: plain.byteLength,
    gzipBytes: gz.byteLength,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(plain).digest("hex"),
    body,
  };
}

/** `backups/{YYYY-MM-DD}/{incremental|full}/{collection}[-{part}].ndjson.gz.age` (part numbers start at 1, only when a collection has several parts). */
export function partKey(date: string, mode: BackupMode, collection: string, part: number | null): string {
  return `backups/${date}/${mode}/${collection}${part === null ? "" : `-${part}`}.ndjson.gz.age`;
}

/** `backups/{YYYY-MM-DD}/auth/users[-{part}].ndjson.gz.age`: Firebase Auth accounts (D20), not Firestore documents. */
export function authPartKey(date: string, part: number | null): string {
  return `backups/${date}/auth/users${part === null ? "" : `-${part}`}.ndjson.gz.age`;
}

export function manifestKey(date: string): string {
  return `backups/${date}/manifest.json.age`;
}

export interface OpenedPart {
  /** The NDJSON lines (no trailing empty line). */
  lines: string[];
  plainBytes: number;
  sha256: string;
}

/** Inverse of sealPart: age -> gunzip (bounded) -> NDJSON lines. Plaintext stays in memory. */
export async function openPart(body: Uint8Array, identity: string): Promise<OpenedPart> {
  const gz = await decryptAge(body, identity);
  const plain = gunzipSync(gz, { maxOutputLength: PART_MAX_PLAIN_BYTES });
  const text = plain.toString("utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return { lines, plainBytes: plain.byteLength, sha256: createHash("sha256").update(plain).digest("hex") };
}

export type BackupKey =
  | { kind: "part"; date: string; mode: BackupMode; collection: string; part: number | null; logical: string }
  | { kind: "manifest"; date: string; logical: string };

const PART_KEY = /(?:^|\/)(\d{4}-\d{2}-\d{2})\/(incremental|full)\/([A-Za-z][A-Za-z0-9_]*?)(?:-([1-9]\d*))?\.ndjson\.gz\.age$/;
const MANIFEST_KEY = /(?:^|\/)(\d{4}-\d{2}-\d{2})\/manifest\.json\.age$/;

/**
 * Recognises a backup object from its key or relative file path, whatever sits before the date
 * ("backups/", a download folder): `logical` is the key from the date on, the same for a manifest
 * entry and the downloaded file. Null for anything else.
 */
export function parseBackupKey(key: string): BackupKey | null {
  const normalized = key.replaceAll("\\", "/");
  const part = PART_KEY.exec(normalized);
  if (part) {
    const [, date, mode, collection, number] = part as unknown as [string, string, BackupMode, string, string | undefined];
    return { kind: "part", date, mode, collection, part: number === undefined ? null : Number(number), logical: `${date}/${mode}/${collection}${number === undefined ? "" : `-${number}`}.ndjson.gz.age` };
  }
  const manifest = MANIFEST_KEY.exec(normalized);
  if (manifest) {
    const date = manifest[1] as string;
    return { kind: "manifest", date, logical: `${date}/manifest.json.age` };
  }
  return null;
}
