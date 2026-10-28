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
// - previous rejections: +10 each, max 30, no flag (history, not content).

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
};

export const PREVIOUS_REJECTION_WEIGHT = 10;
export const PREVIOUS_REJECTION_CAP = 30;

/** Flags that send the listing to review whatever the score (step 2 soft hits, step 3 legal review, step 5 nudity). */
export const ALWAYS_REVIEW_FLAGS: ReadonlySet<ModerationFlag> = new Set<ModerationFlag>(["prohibited_kw", "prohibited_soft", "sensitive_text", "third_party_phone", "nsfw_review", "restricted_category", "face", "credit_ad"]);

/** Flags the agent may never lift alone, whatever `agent.autoApproveSoftFlags` says (a moderator decides). */
export const HUMAN_REVIEW_FLAGS: ReadonlySet<ModerationFlag> = new Set<ModerationFlag>(["restricted_category", "face"]);

/** `accountAgeDays` below which `new_account` is raised (lot decision; architecture §7 cites 7 days for the AI agent context). */
export const NEW_ACCOUNT_DAYS = 1;
/** `listingsLast24h` from which `volume` is raised. */
export const VOLUME_PER_DAY = 3;

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
export function riskScore(flags: Iterable<ModerationFlag>, history: { previousRejections?: number } = {}): RiskScore {
  const unique = new Set(flags);
  const terms: RiskTerm[] = [];
  for (const flag of MODERATION_FLAGS) {
    if (!unique.has(flag)) continue;
    const { weight, reason } = RISK_WEIGHTS[flag];
    terms.push({ reason, points: weight });
  }
  const rejections = Math.max(0, Math.floor(history.previousRejections ?? 0));
  if (rejections > 0) {
    terms.push({ reason: `${rejections} previous rejection(s)`, points: Math.min(PREVIOUS_REJECTION_CAP, rejections * PREVIOUS_REJECTION_WEIGHT) });
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
