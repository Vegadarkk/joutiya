import { z } from "../lib/zod.ts";
import { PROHIBITED_GROUP_IDS, type ProhibitedGroupId } from "./prohibited.ts";
import { RATE_LIMITS, type RateLimitId } from "./rate-limits.ts";

// Firestore `config/abuse` (spec §10 launch item: the committed anti-abuse values are public while the
// repository is): private overrides of the pre-moderation risk thresholds, extra moderation terms
// and rate limits, read server-side only (src/lib/config/runtime.ts `getAbuse`, 5-minute cache).
// This file holds the schema and the defaults, equal to the committed values: an absent document
// changes nothing. Extra terms add to src/config/prohibited.ts and src/config/payment-keywords.ts
// (they never remove one) and never reach the browser. Relative imports: scripts/abuse-config.ts
// loads this file with plain Node.

/** MODERATION_FLAGS of src/lib/contracts/listings.ts (alias imports, not loadable by the script); a unit test keeps them equal. */
export const RISK_FLAG_IDS = [
  "prohibited_kw",
  "prohibited_soft",
  "sensitive_text",
  "third_party_phone",
  "face",
  "nsfw_review",
  "price_outlier",
  "dup_text",
  "dup_photo",
  "new_account",
  "volume",
  "restricted_category",
  "credit_ad",
  "sanitary_check",
  "rental_review",
  "promo_check",
] as const;
export type RiskFlagId = (typeof RISK_FLAG_IDS)[number];

/** The proxy applies `pages.*` on the committed values (proxy-limits.ts: no Firestore on the page path): not overridable. */
export const OVERRIDABLE_RATE_LIMIT_IDS = (Object.keys(RATE_LIMITS) as RateLimitId[]).filter((id) => !id.startsWith("pages.")) as [RateLimitId, ...RateLimitId[]];
const MAX_WINDOW = 31 * 24 * 60 * 60;

const points = z.number().int().min(0).max(100);
/** A term as people type it; folded by normalizeText like the committed lists. */
const terms = z.array(z.string().trim().min(2).max(80)).max(500);

export const abuseRiskSchema = z
  .object({
    /** `accountAgeDays` below which `new_account` is raised (risk.ts NEW_ACCOUNT_DAYS). */
    newAccountDays: z.number().int().min(0).max(365),
    /** `listingsLast24h` from which `volume` is raised (risk.ts VOLUME_PER_DAY). */
    volumePerDay: z.number().int().min(1).max(1000),
    /** Weight overrides by flag (risk.ts RISK_WEIGHTS); a flag left out keeps its committed weight. */
    weights: z.partialRecord(z.enum(RISK_FLAG_IDS), points),
    /** Points per previous rejection of the seller, and their cap. */
    previousRejectionWeight: points,
    previousRejectionCap: points,
  })
  .strict();

export const prohibitedExtraSchema = z.object({ hard: terms.optional(), soft: terms.optional() }).strict();

export const abuseMessagingSchema = z
  .object({
    /** Added to PAYMENT_KEYWORDS (message flag `payment_kw`, place refusal). */
    paymentKeywords: terms,
    /** Added to CONTACT_APP_KEYWORDS (`contact_with_payment_kw` with a payment keyword). */
    contactAppKeywords: terms,
  })
  .strict();

export const rateLimitOverrideSchema = z
  .object({
    points: z.number().int().min(1).max(1_000_000).optional(),
    duration: z.number().int().min(1).max(MAX_WINDOW).optional(),
    blockDuration: z.number().int().min(0).max(MAX_WINDOW).optional(),
  })
  .strict();

export const abuseConfigSchema = z
  .object({
    risk: abuseRiskSchema,
    /** Extra terms by prohibited group, merged with src/config/prohibited.ts at match time. */
    prohibited: z.partialRecord(z.enum(PROHIBITED_GROUP_IDS), prohibitedExtraSchema),
    messaging: abuseMessagingSchema,
    /** Overrides by RATE_LIMITS id; the policy and the key stay the committed ones. */
    rateLimits: z.partialRecord(z.enum(OVERRIDABLE_RATE_LIMIT_IDS), rateLimitOverrideSchema),
  })
  .strict();
export type AbuseConfig = z.infer<typeof abuseConfigSchema>;
export type AbuseRiskConfig = AbuseConfig["risk"];
export type ProhibitedExtraTerms = Partial<Record<ProhibitedGroupId, z.infer<typeof prohibitedExtraSchema>>>;
export type RateLimitOverrides = AbuseConfig["rateLimits"];

export const DEFAULT_ABUSE: AbuseConfig = {
  risk: { newAccountDays: 1, volumePerDay: 3, weights: {}, previousRejectionWeight: 10, previousRejectionCap: 30 },
  prohibited: {},
  messaging: { paymentKeywords: [], contactAppKeywords: [] },
  rateLimits: {},
};

/** Editing metadata an admin's write may carry next to the sections: ignored, never an error. */
const METADATA_KEYS: ReadonlySet<string> = new Set(["updatedAt", "updatedBy"]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const message = (error: z.ZodError) => error.issues[0]?.message ?? "invalid";

/** Field by field over the default section: a valid field applies even when its neighbour is mistyped. */
function resolveFields<T extends Record<string, unknown>>(name: string, schema: z.ZodObject, fallback: T, value: unknown, errors: string[]): T {
  if (!isObject(value)) {
    errors.push(`${name}: not an object`);
    return fallback;
  }
  const out: Record<string, unknown> = { ...fallback };
  for (const [key, field] of Object.entries(value)) {
    const fieldSchema = schema.shape[key] as z.ZodType | undefined;
    if (!fieldSchema) {
      errors.push(`${name}.${key}: unknown field`);
      continue;
    }
    const parsed = fieldSchema.safeParse(field);
    if (parsed.success) out[key] = parsed.data;
    else errors.push(`${name}.${key}: ${message(parsed.error)}`);
  }
  return out as T;
}

/** Entry by entry: a valid id applies even when another one is unknown or mistyped. */
function resolveEntries<V>(name: string, ids: readonly string[], schema: z.ZodType<V>, value: unknown, errors: string[]): Partial<Record<string, V>> {
  if (!isObject(value)) {
    errors.push(`${name}: not an object`);
    return {};
  }
  const out: Partial<Record<string, V>> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!ids.includes(id)) {
      errors.push(`${name}.${id}: unknown id`);
      continue;
    }
    const parsed = schema.safeParse(entry);
    if (parsed.success) out[id] = parsed.data;
    else errors.push(`${name}.${id}: ${message(parsed.error)}`);
  }
  return out;
}

/**
 * Firestore value over the defaults, field by field (risk, messaging) and entry by entry
 * (prohibited groups, rate-limit ids): an error is reported (the runtime raises a P1 alert) and only
 * the faulty part falls back to its default.
 */
export function resolveAbuseConfig(stored: unknown): { config: AbuseConfig; errors: string[] } {
  if (stored === undefined || stored === null) return { config: DEFAULT_ABUSE, errors: [] };
  if (!isObject(stored)) return { config: DEFAULT_ABUSE, errors: ["config/abuse: not an object"] };
  const config: AbuseConfig = { ...DEFAULT_ABUSE };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (METADATA_KEYS.has(key)) continue;
    if (key === "risk") config.risk = resolveFields("risk", abuseRiskSchema, DEFAULT_ABUSE.risk, value, errors);
    else if (key === "messaging") config.messaging = resolveFields("messaging", abuseMessagingSchema, DEFAULT_ABUSE.messaging, value, errors);
    else if (key === "prohibited") config.prohibited = resolveEntries("prohibited", PROHIBITED_GROUP_IDS, prohibitedExtraSchema, value, errors);
    else if (key === "rateLimits") config.rateLimits = resolveEntries("rateLimits", OVERRIDABLE_RATE_LIMIT_IDS, rateLimitOverrideSchema, value, errors);
    else errors.push(`${key}: unknown section`);
  }
  return { config, errors };
}
