import { createHash } from "node:crypto";
import { normalizeText } from "@/lib/text/normalize";

// Text fingerprint for duplicate detection (architecture §7 step 4 "doublon texte"): sha256 of the
// normalised title and description. Server-only by nature (node:crypto): never re-exported from the
// moderation barrel, import it from this file in server code only.

/** Hex sha256 of `normalizeText(title)` + "\n" + `normalizeText(description)`. */
export function textFingerprint(title: string, description: string): string {
  return createHash("sha256").update(`${normalizeText(title)}\n${normalizeText(description)}`, "utf8").digest("hex");
}
