import type { AiConfig } from "@/config/ai";
import type { FieldIssue, ModerationFlag, SensitiveDeclarationKind } from "@/lib/contracts/listings";

// Types of the pre-moderation screen (architecture §7 steps 1-5, design D8). Pure data: the
// listing service builds `ScreenInput` from the draft, the seller and the duplicate lookups, and
// stores `ScreenResult` in `moderation`. `FieldIssue` is the contracts' shape ({ path, code }), so
// blockers go straight into the 422 `invalid_listing` answer.

export type { FieldIssue, ModerationFlag };

/** Attribute values as stored on the listing. */
export type ScreenAttributes = Record<string, string | number | boolean | string[]>;

export interface ScreenPhoto {
  /** Scores of the local image models for this photo (absent while processing). */
  checks?: { nsfw?: number; faces?: number };
}

export interface ScreenSeller {
  accountAgeDays: number;
  listingsLast24h: number;
  phoneVerified: boolean;
  previousRejections: number;
}

export interface ScreenDuplicates {
  /** Other listings of the platform with the same `textFingerprint`. */
  sameText: number;
  /** Other listings sharing a photo hash (dHash). */
  samePhoto: number;
}

export interface ScreenInput {
  title: string;
  description: string;
  attributes: ScreenAttributes;
  categoryId: string;
  subcategoryId: string;
  price: number | null;
  isDonation: boolean;
  contact: { showPhone: boolean; whatsapp: boolean };
  sensitiveDeclaration?: { kind: SensitiveDeclarationKind } | null;
  photos: ScreenPhoto[];
  seller: ScreenSeller;
  duplicates?: ScreenDuplicates;
}

export interface ScreenContext {
  ai: AiConfig;
  /** Reserved for time-based rules; the screen is otherwise independent of the clock. */
  now?: Date;
}

export type ScreenState = "auto_ok" | "needs_review";

export interface ScreenResult {
  /** `needs_review` when the risk score reaches `ai.risk.reviewAt` or an always-review flag is raised. */
  state: ScreenState;
  /** Risk score, integer 0-100 (src/lib/moderation/risk.ts). */
  score: number;
  /** Soft signals, in `MODERATION_FLAGS` order. */
  flags: ModerationFlag[];
  /** Hard blockers (422 at publish). Empty when the listing may be stored. */
  blockers: FieldIssue[];
  /** Short machine-readable hints for the moderator, never personal data. */
  evidence: string[];
}

/** Codes of the blockers raised by the screen (client messages: `Listing.validation.<code>`). */
export const SCREEN_BLOCKER_CODES = ["phone_in_text", "email_in_text", "url_in_text", "prohibited", "required", "invalid", "unknown", "not_allowed", "phone_required"] as const;
export type ScreenBlockerCode = (typeof SCREEN_BLOCKER_CODES)[number];

export interface PhoneMatch {
  /** Text as written, for highlighting in the wizard (never logged). */
  raw: string;
  /** E.164 form when the digits parse as a possible number. */
  e164?: string;
}

export interface ContactMatch {
  kind: "email" | "url";
  raw: string;
}
