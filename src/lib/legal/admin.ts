import "server-only";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { LEGAL_PAGES } from "@/config/legal-pages";
import { LOCALES } from "@/config/site";
import { DEFAULT_LEGAL, legalConfigSchema, missingLegalMentions, resolveLegalConfig, type LegalConfig } from "@/config/legal";
import { audit } from "@/lib/audit";
import type { StaffContext } from "@/lib/auth/guards";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { HttpError, unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { z } from "@/lib/zod";
import { invalidateLegalConfig } from "./config";

// Back-office edition of Firestore `config/legal` (phase 6, D13): same schema as
// scripts/legal-config.ts, which stays for the first write and for rebuilds. The document keeps
// only the fields that differ from DEFAULT_LEGAL, like the script's file; every save is journaled
// with its changes (`legal.updated`).

export interface LegalAdminView {
  config: LegalConfig;
  /** Fields of the stored document the app ignores (invalid): the defaults are rendered meanwhile. */
  errors: string[];
  /** Mentions art. 1-1 LCEN still needs (production refuses to start). */
  missing: string[];
  /** Fields that differ from the defaults (what the document holds after a save). */
  overridden: string[];
  /** Version of the stored document: a save against another version is refused (409). */
  version: string;
}

export const legalUpdateSchema = z.object({ config: legalConfigSchema.strict(), version: z.string().min(1).max(64) }).strict();
export type LegalUpdateRequest = z.infer<typeof legalUpdateSchema>;

export interface LegalChange {
  path: string;
  before: string;
  after: string;
}

/** Version of a stored document (absent: "none"). */
export function legalVersion(stored: unknown): string {
  if (stored === undefined || stored === null) return "none";
  return createHash("sha256").update(stableJson(stored)).digest("base64url").slice(0, 22);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The fields of `config` that differ from the defaults: the document to store. */
export function legalOverrides(config: LegalConfig): Partial<LegalConfig> {
  return Object.fromEntries(
    (Object.keys(config) as (keyof LegalConfig)[]).filter((key) => stableJson(config[key]) !== stableJson(DEFAULT_LEGAL[key])).map((key) => [key, config[key]]),
  ) as Partial<LegalConfig>;
}

function leaves(value: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(path, "[]");
    value.forEach((item, index) => leaves(item, `${path}[${index}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) leaves(item, path ? `${path}.${key}` : key, out);
  } else {
    out.set(path, typeof value === "string" ? value : String(value));
  }
}

/** Leaf-level changes between two configs, in field order (a removed list item shows as emptied). */
export function legalChanges(before: LegalConfig, after: LegalConfig): LegalChange[] {
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  leaves(before, "", left);
  leaves(after, "", right);
  const paths = [...new Set([...left.keys(), ...right.keys()])];
  return paths.filter((path) => left.get(path) !== right.get(path)).map((path) => ({ path, before: left.get(path) ?? "", after: right.get(path) ?? "" }));
}

const REASON_MAX = 500;
const VALUE_MAX = 60;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Audit reason: `path: "before" → "after"` per change, within the 500 characters of the entry. */
export function legalAuditReason(changes: readonly LegalChange[]): string {
  const parts = changes.map(({ path, before, after }) => `${path}: ${JSON.stringify(clip(before, VALUE_MAX))} → ${JSON.stringify(clip(after, VALUE_MAX))}`);
  const room = REASON_MAX - 8; // " (+NNN)" when some changes do not fit
  let reason = "";
  let kept = 0;
  for (const part of parts) {
    const next = reason ? `${reason}; ${part}` : part;
    if (next.length > room) break;
    reason = next;
    kept += 1;
  }
  if (kept === 0 && parts.length > 0) {
    reason = clip(parts[0]!, room);
    kept = 1;
  }
  return kept < parts.length ? `${reason} (+${parts.length - kept})` : reason;
}

/** Every locale of every legal page (ISR, regenerated on their next visit). */
export function legalPagePaths(): string[] {
  return LOCALES.flatMap((locale) => LEGAL_PAGES.map((page) => `/${locale}/legal/${page.slug}`));
}

const DOC = () => db().collection("config").doc("legal");

export async function readLegalAdmin(): Promise<LegalAdminView> {
  if (!isFirestoreConfigured()) return view(undefined);
  const snapshot = await DOC().get();
  void consume("firestore.reads", 1);
  return view(snapshot.exists ? snapshot.data() : undefined);
}

function view(stored: unknown): LegalAdminView {
  const { config, errors } = resolveLegalConfig(stored);
  return { config, errors, missing: missingLegalMentions(config), overridden: Object.keys(legalOverrides(config)), version: legalVersion(stored) };
}

/** Writes the new config when the stored version still matches; journals the changes. */
export async function saveLegalConfig(ctx: StaffContext, request: LegalUpdateRequest, ip: string | undefined): Promise<LegalAdminView> {
  const { config } = request;
  const missing = missingLegalMentions(config);
  if (missing.length > 0) throw new HttpError(422, "legal_incomplete", undefined, { details: { missing } });
  if (!isFirestoreConfigured()) throw unavailable("Firestore is not configured");

  const overrides = legalOverrides(config);
  const { changes, replacedInvalid, stored } = await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(DOC());
    const stored = snapshot.exists ? snapshot.data() : undefined;
    if (legalVersion(stored) !== request.version) throw new HttpError(409, "conflict", "config/legal changed since it was read");
    const current = resolveLegalConfig(stored);
    const found = legalChanges(current.config, config);
    const invalid = current.errors.length > 0;
    if (found.length > 0 || invalid) transaction.set(DOC(), overrides);
    return { changes: found, replacedInvalid: invalid, stored };
  });
  void consume("firestore.reads", 1);
  // Nothing written: the document and its version stay as they were.
  if (changes.length === 0 && !replacedInvalid) return view(stored);
  void consume("firestore.writes", 1);

  const reason = legalAuditReason(changes);
  await audit({
    actorUid: ctx.user.uid,
    actorRole: ctx.role,
    action: "legal.updated",
    target: { type: "config", id: "legal" },
    automated: false,
    // An invalid document (rendered as the defaults) is replaced even without a visible change.
    reason: replacedInvalid ? clip(`invalid document replaced${reason ? `; ${reason}` : ""}`, REASON_MAX) : reason,
    ip,
  });
  invalidateLegalConfig();
  for (const path of legalPagePaths()) {
    try {
      revalidatePath(path);
    } catch (error) {
      logger.debug({ path, err: (error as Error).message }, "revalidatePath skipped (no request context)");
    }
  }
  return view(overrides);
}
