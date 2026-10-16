import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { encryptAge } from "./crypto.ts";

// Parts of a backup (D17): NDJSON lines grouped by <= 20 000 documents or <= 16 MiB of NDJSON,
// whichever comes first, then gzip (compress BEFORE encrypting: ciphertext is incompressible),
// then age. One part at a time stays in memory (< 32 MiB). Pure module (no server-only, no "@/").

export const PART_MAX_DOCS = 20_000;
export const PART_MAX_BYTES = 16 * 1024 * 1024;

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

  constructor(private readonly limits: PartLimits = { maxDocs: PART_MAX_DOCS, maxBytes: PART_MAX_BYTES }) {
    if (!(limits.maxDocs >= 1) || !(limits.maxBytes >= 1)) throw new RangeError("part limits must be positive");
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

export function manifestKey(date: string): string {
  return `backups/${date}/manifest.json.age`;
}
