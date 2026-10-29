import "server-only";
import { createHash } from "node:crypto";
import type { AiConfig } from "@/config/ai";
import { aiConfig } from "@/lib/ai/config";
import { subcategoryById } from "@/config/categories";
import { isVariantCriterion, withVariantAnswers } from "@/lib/contracts/catalog";
import { getAbuseRules } from "@/lib/config/runtime";
import type { FieldIssue, ModerationFlag } from "@/lib/contracts/listings";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UploadRecord } from "@/lib/db/repositories/uploads";
import type { ListingDoc } from "@/lib/db/schemas";
import type { AbuseRules } from "@/lib/moderation/abuse";
import { screenListing } from "@/lib/moderation/screen";
import type { ScreenDuplicates, ScreenInput } from "@/lib/moderation/types";
import { normalizeText } from "@/lib/text/normalize";

// Adapter between a listing (document + uploads + seller facts) and the moderation core
// (src/lib/moderation/screen.ts, architecture §7 steps 2-4). The core knows texts, prices, photo
// checks and seller facts; this module knows where they live and computes the duplicate signals
// from the owner's other listings (text fingerprint, photo dHash equality).

export interface SellerFacts {
  accountAgeDays: number;
  listingsLast24h: number;
  phoneVerified: boolean;
  previousRejections: number;
  /** ONSSA numbers a moderator already checked for the seller's shop. */
  sanitaryNumbers?: readonly string[];
}

export interface ScreeningResult {
  state: "auto_ok" | "needs_review";
  score: number;
  flags: ModerationFlag[];
  blockers: FieldIssue[];
  evidence: string[];
}

export interface ScreeningInput {
  listing: ListingDoc;
  /** Uploads of the attached photos (for their nsfw / faces checks); missing ones count as unchecked. */
  uploads: readonly Pick<UploadRecord, "id" | "checks">[];
  seller: SellerFacts;
  /** The owner's other listings that may duplicate this one (published, pending, paused). */
  others: readonly Pick<ListingRecord, "id" | "title" | "description" | "photos">[];
  /** Absent: Firestore `config/ai` (5-minute cache, src/lib/ai/config.ts). */
  ai?: AiConfig;
  /** Absent: Firestore `config/abuse` (5-minute cache), whose defaults are the committed values. */
  abuse?: AbuseRules;
}

/** sha256 of the normalised title + description: two listings with the same text share it. */
export function textFingerprint(title: string, description: string): string {
  return createHash("sha256").update(`${normalizeText(title)}\n${normalizeText(description)}`).digest("hex");
}

/** How many of the owner's other listings share the text fingerprint, and how many share a photo hash. */
export function detectDuplicates(listing: Pick<ListingDoc, "title" | "description" | "photos">, others: ScreeningInput["others"], selfId?: string): ScreenDuplicates {
  const fingerprint = textFingerprint(listing.title, listing.description);
  const hashes = new Set(listing.photos.map((photo) => photo.hash).filter((hash): hash is string => Boolean(hash)));
  let sameText = 0;
  let samePhoto = 0;
  for (const other of others) {
    if (selfId && other.id === selfId) continue;
    if (textFingerprint(other.title, other.description) === fingerprint) sameText += 1;
    if (hashes.size > 0 && other.photos.some((photo) => photo.hash && hashes.has(photo.hash))) samePhoto += 1;
  }
  return { sameText, samePhoto };
}

/**
 * Seller facts from the account and its other listings (volume = the last 24 hours). `selfRejected`:
 * the screened listing itself was rejected by a moderator (reopened since), one more rejection.
 */
export function sellerFacts(input: { accountCreatedAt: Date; phoneVerified: boolean; others: readonly Pick<ListingRecord, "createdAt" | "status">[]; selfRejected?: boolean; sanitaryNumbers?: readonly string[]; now: Date }): SellerFacts {
  const dayAgo = input.now.getTime() - 24 * 60 * 60 * 1000;
  return {
    accountAgeDays: Math.max(0, Math.floor((input.now.getTime() - input.accountCreatedAt.getTime()) / (24 * 60 * 60 * 1000))),
    listingsLast24h: input.others.filter((other) => other.createdAt.getTime() >= dayAgo).length,
    phoneVerified: input.phoneVerified,
    previousRejections: input.others.filter((other) => other.status === "rejected").length + (input.selfRejected ? 1 : 0),
    sanitaryNumbers: input.sanitaryNumbers ?? [],
  };
}

/** Runs the moderation core on a listing; hard blockers come back as field issues, soft signals as flags. */
export async function screen(facts: ScreeningInput, selfId?: string): Promise<ScreeningResult> {
  const { listing } = facts;
  const checks = new Map(facts.uploads.map((upload) => [upload.id, upload.checks]));
  const duplicates = detectDuplicates(listing, facts.others, selfId);
  const input: ScreenInput = {
    title: listing.title,
    description: listing.description,
    // A criterion a variant axis takes over (the size of clothes) is answered by the axis.
    attributes: withVariantAnswers(listing.attributes, listing.variants, subcategoryById(listing.subcategoryId ?? "")?.criteria.map((criterion) => criterion.id) ?? []),
    categoryId: listing.categoryId ?? "",
    subcategoryId: listing.subcategoryId ?? "",
    price: listing.price,
    isDonation: listing.isDonation,
    contact: { showPhone: listing.contact.showPhone, whatsapp: listing.contact.whatsapp },
    sensitiveDeclaration: listing.moderation.sensitiveDeclaration ? { kind: listing.moderation.sensitiveDeclaration.kind } : null,
    ...(listing.location?.district ? { district: listing.location.district } : {}),
    ...(listing.variants ? { variantAxes: listing.variants.axes.filter((axis) => !isVariantCriterion(axis.id)) } : {}),
    photos: listing.photos.map((photo) => ({ checks: checks.get(photo.id) })),
    seller: facts.seller,
    duplicates,
  };
  const result = screenListing(input, { ai: facts.ai ?? (await aiConfig()), abuse: facts.abuse ?? (await getAbuseRules()) });
  return {
    state: result.state,
    score: result.score,
    flags: [...result.flags],
    blockers: [...result.blockers],
    evidence: [...(result.evidence ?? [])],
  };
}
