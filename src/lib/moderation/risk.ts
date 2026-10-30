import { DEFAULT_ABUSE, type AbuseRiskConfig } from "@/config/abuse";
import { MODERATION_FLAGS, type ModerationFlag } from "@/lib/contracts/listings";
import type { ScreenState } from "@/lib/moderation/types";

// Risk score of a listing (architecture §7 step 4, design D8): weighted sum of the soft flags plus
// the seller's previous rejections, capped at 100. `needs_review` when the score reaches
// `ai.risk.reviewAt` (default 60) or when an always-review flag is raised. Pure, client-safe.
//
// Why these weights (reasons are the moderator-facing wording):
// - prohibited_kw 60: a hard keyword is a 422 blocker; the flag only documents a blocked attempt.
// - nsfw_review 40, prohibited_soft 35, dup_* 30: strong signals, each one near the threshold.
// - sensitive_text / third_party_phone 25 / 20: legally mandatory review (step 3) -> always review.
// - credit_ad 25: instalment without the APR (loi 31-08 art. 76), the mentions are checked by a person -> always review.
// - price_outlier 20, new_account 15, volume 15: weak alone, review when combined
//   (new account + volume + outlier = 50 stays auto; + a duplicate -> review).
// - restricted_category 0, face 0: not risk signals but rules, always reviewed by a person, never
//   auto-approved by the agent (HUMAN_REVIEW_FLAGS): an adults-only subcategory (decorative
//   koumiyas); a photo the seller kept with a face after the wizard proposed to crop it (CGU §7,
//   privacy policy §4.4: « recadrage proposé, sinon examen humain », phase 6 decision).
// - sanitary_check 0: a rule too, never auto-approved: the first listing of a shop with a given ONSSA
//   number (Produits du terroir); the moderator checks it in the ONSSA lists, then the shop's later
//   listings with that number pass (owner decision of 2026-10-28).
// - rental_review 25: car rental with driver, identity paper or blank cheque as a guarantee, or a
//   vehicle past the fleet age limit (rental pack §2) -> always review.
// - promo_check 0: a promotion of more than 70 % (catalogue §4), raised by the promotion service
//   itself, never by the pre-moderation screen; the listing is held until a moderator checks it.
// - work_abroad 0: a job offer for a post abroad (Emploi frame of 2026-10-30; Code du travail
//   arts. 489, 512-515): a moderator checks the visa and agency mentions, never the agent.
// - previous rejections: +10 each, max 30, no flag (history, not content).
// Live values: Firestore `config/abuse` `risk` (src/config/abuse.ts) overrides the thresholds, the
// weights and the rejection terms through `riskRules`; the committed values here are the defaults.

export interface RiskWeight {
  weight: number;
  reason: string;
}

export const RISK_WEIGHTS: Readonly<Record<ModerationFlag, RiskWeight>> = {
  prohibited_kw: { weight: 60, reason: "hard prohibited keyword" },
  prohibited_soft: { weight: 35, reason: "ambiguous prohibited keyword" },
  sensitive_text: { weight: 25, reason: "sensitive personal data in text" },
  third_party_phone: { weight: 20, reason: "several phone numbers in text" },
  face: { weight: 0, reason: "identifiable face kept on a photo, human review required" },
  nsfw_review: { weight: 40, reason: "nudity score in the review band" },
  price_outlier: { weight: 20, reason: "price outside the subcategory envelope" },
  dup_text: { weight: 30, reason: "same text as another listing" },
  dup_photo: { weight: 30, reason: "same photo as another listing" },
  new_account: { weight: 15, reason: "account younger than the threshold" },
  volume: { weight: 15, reason: "many listings in 24 hours" },
  restricted_category: { weight: 0, reason: "adults-only subcategory, human review required" },
  credit_ad: { weight: 25, reason: "instalment quoted without the APR (loi 31-08 art. 76), review required" },
  sanitary_check: { weight: 0, reason: "ONSSA number new for the shop, human check required" },
  rental_review: { weight: 25, reason: "car rental with driver, identity paper or blank cheque as a guarantee, or vehicle past the fleet age limit, human review required" },
  promo_check: { weight: 0, reason: "promotion cutting more than 70 % off the struck-out price, human check of the starting price required" },
  work_abroad: { weight: 0, reason: "job offer for a post abroad, human check of the visa and agency mentions required" },
};

export const PREVIOUS_REJECTION_WEIGHT = DEFAULT_ABUSE.risk.previousRejectionWeight;
export const PREVIOUS_REJECTION_CAP = DEFAULT_ABUSE.risk.previousRejectionCap;

/** Flags that send the listing to review whatever the score (step 2 soft hits, step 3 legal review, step 5 nudity). */
export const ALWAYS_REVIEW_FLAGS: ReadonlySet<ModerationFlag> = new Set<ModerationFlag>(["prohibited_kw", "prohibited_soft", "sensitive_text", "third_party_phone", "nsfw_review", "restricted_category", "face", "credit_ad", "sanitary_check", "rental_review", "promo_check", "work_abroad"]);

/** Flags the agent may never lift alone, whatever `agent.autoApproveSoftFlags` says (a moderator decides). */
export const HUMAN_REVIEW_FLAGS: ReadonlySet<ModerationFlag> = new Set<ModerationFlag>(["restricted_category", "face", "sanitary_check", "promo_check", "work_abroad"]);

/** `accountAgeDays` below which `new_account` is raised (lot decision; architecture §7 cites 7 days for the AI agent context). */
export const NEW_ACCOUNT_DAYS = DEFAULT_ABUSE.risk.newAccountDays;
/** `listingsLast24h` from which `volume` is raised. */
export const VOLUME_PER_DAY = DEFAULT_ABUSE.risk.volumePerDay;

/** Effective risk settings: the committed weights and thresholds under the `config/abuse` overrides. */
export interface RiskRules {
  weights: Readonly<Record<ModerationFlag, number>>;
  previousRejectionWeight: number;
  previousRejectionCap: number;
  newAccountDays: number;
  volumePerDay: number;
}

export function riskRules(risk: AbuseRiskConfig = DEFAULT_ABUSE.risk): RiskRules {
  const weights = Object.fromEntries(MODERATION_FLAGS.map((flag) => [flag, risk.weights[flag] ?? RISK_WEIGHTS[flag].weight])) as Record<ModerationFlag, number>;
  return { weights, previousRejectionWeight: risk.previousRejectionWeight, previousRejectionCap: risk.previousRejectionCap, newAccountDays: risk.newAccountDays, volumePerDay: risk.volumePerDay };
}

export const DEFAULT_RISK_RULES: RiskRules = riskRules();

export interface RiskTerm {
  reason: string;
  points: number;
}

export interface RiskScore {
  /** Integer 0-100. */
  score: number;
  terms: RiskTerm[];
}

/** Weighted sum of the flags and the rejection history, capped at 100. Deterministic for a given input. */
export function riskScore(flags: Iterable<ModerationFlag>, history: { previousRejections?: number } = {}, rules: RiskRules = DEFAULT_RISK_RULES): RiskScore {
  const unique = new Set(flags);
  const terms: RiskTerm[] = [];
  for (const flag of MODERATION_FLAGS) {
    if (!unique.has(flag)) continue;
    terms.push({ reason: RISK_WEIGHTS[flag].reason, points: rules.weights[flag] });
  }
  const rejections = Math.max(0, Math.floor(history.previousRejections ?? 0));
  if (rejections > 0) {
    terms.push({ reason: `${rejections} previous rejection(s)`, points: Math.min(rules.previousRejectionCap, rejections * rules.previousRejectionWeight) });
  }
  const total = terms.reduce((sum, term) => sum + term.points, 0);
  return { score: Math.min(100, total), terms };
}

export interface DecideOptions {
  /** `ai.risk.reviewAt`. */
  reviewAt: number;
  alwaysReview?: ReadonlySet<ModerationFlag>;
}

export function decideState(score: number, flags: Iterable<ModerationFlag>, options: DecideOptions): ScreenState {
  const always = options.alwaysReview ?? ALWAYS_REVIEW_FLAGS;
  for (const flag of flags) {
    if (always.has(flag)) return "needs_review";
  }
  return score >= options.reviewAt ? "needs_review" : "auto_ok";
}

/** Flags in `MODERATION_FLAGS` order, unique. */
export function sortFlags(flags: Iterable<ModerationFlag>): ModerationFlag[] {
  const unique = new Set(flags);
  return MODERATION_FLAGS.filter((flag) => unique.has(flag));
}
