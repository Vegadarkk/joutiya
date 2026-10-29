import { criteriaSchema, sanitaryNumber, subcategoryById } from "@/config/categories";
import { isPriceOutlier, priceRange } from "@/config/price-ranges";
import type { ModerationFlag } from "@/lib/contracts/listings";
import { findContacts } from "@/lib/moderation/contacts";
import { quotesCreditWithoutApr } from "@/lib/moderation/credit";
import { rentalReviewReasons } from "./rental";
import { findPhoneNumbers } from "@/lib/moderation/phones";
import { containsProhibited } from "@/lib/moderation/prohibited";
import { DEFAULT_RISK_RULES, decideState, riskScore, sortFlags } from "@/lib/moderation/risk";
import { detectSensitiveDetailed } from "@/lib/moderation/sensitive";
import type { FieldIssue, ScreenBlockerCode, ScreenContext, ScreenInput, ScreenResult } from "@/lib/moderation/types";

// Pre-publication screen (architecture §7 steps 1-5, design D8), pure and deterministic. The
// listing service calls it at publish, on an edit of a published, paused, pending or expired
// listing, and when an expired listing is renewed:
//   blockers.length > 0 -> 422 `invalid_listing` with `blockers` as details;
//   otherwise `state` / `score` / `flags` go to `moderation`, `needs_review` -> `pending_review`.
// Step 6 (AI agent) is phase 5 and absent on purpose. Evidence strings carry no personal data.

type TextField = { path: string; text: string };

function issue(path: string, code: ScreenBlockerCode): FieldIssue {
  return { path, code };
}

function pushIssue(blockers: FieldIssue[], next: FieldIssue): void {
  if (!blockers.some((b) => b.path === next.path && b.code === next.code)) blockers.push(next);
}

/** Title, description, the free-text attributes in key order, the district, then the free variant axes. */
function textFields(input: ScreenInput): TextField[] {
  const fields: TextField[] = [
    { path: "title", text: input.title ?? "" },
    { path: "description", text: input.description ?? "" },
  ];
  for (const key of Object.keys(input.attributes ?? {}).sort()) {
    const value = input.attributes[key];
    if (typeof value === "string" && value.trim() !== "") fields.push({ path: `attributes.${key}`, text: value });
  }
  if (input.district && input.district.trim() !== "") fields.push({ path: "location.district", text: input.district });
  (input.variantAxes ?? []).forEach((axis, index) => {
    if (axis.label) fields.push({ path: `variants.axes.${index}.label`, text: axis.label });
    axis.values.forEach((value, at) => fields.push({ path: `variants.axes.${index}.values.${at}`, text: value }));
  });
  return fields;
}

function checkTree(input: ScreenInput, blockers: FieldIssue[]): void {
  const subcategory = subcategoryById(input.subcategoryId);
  if (!subcategory) {
    pushIssue(blockers, issue("subcategoryId", input.subcategoryId ? "unknown" : "required"));
    return;
  }
  if (subcategory.categoryId !== input.categoryId) pushIssue(blockers, issue("categoryId", "invalid"));

  const attributes = input.attributes ?? {};
  const parsed = criteriaSchema(subcategory.id).safeParse(attributes);
  if (!parsed.success) {
    for (const zodIssue of parsed.error.issues) {
      if (zodIssue.code === "unrecognized_keys") {
        for (const key of zodIssue.keys) pushIssue(blockers, issue(`attributes.${key}`, "unknown"));
        continue;
      }
      const key = String(zodIssue.path[0] ?? "");
      const value = attributes[key];
      const missing = value === undefined || (typeof value === "string" && value.trim() === "");
      pushIssue(blockers, issue(key ? `attributes.${key}` : "attributes", missing ? "required" : "invalid"));
    }
  }

  // D4: price null only for donations or `priceOptional` subcategories; donation only where allowed.
  if (input.isDonation && !subcategory.donationAllowed) pushIssue(blockers, issue("isDonation", "not_allowed"));
  if (input.price === null && !input.isDonation && !subcategory.priceOptional) pushIssue(blockers, issue("price", "required"));
}

function checkContact(input: ScreenInput, blockers: FieldIssue[]): void {
  // Adults-only goods: the buyer's 18+ confirmation is asked at the first message, so no other channel.
  if (subcategoryById(input.subcategoryId)?.adultsOnly) {
    if (input.contact.showPhone) pushIssue(blockers, issue("contact.showPhone", "messaging_only"));
    if (input.contact.whatsapp) pushIssue(blockers, issue("contact.whatsapp", "messaging_only"));
    return;
  }
  if (!input.seller.phoneVerified) {
    if (input.contact.showPhone) pushIssue(blockers, issue("contact.showPhone", "phone_required"));
    if (input.contact.whatsapp) pushIssue(blockers, issue("contact.whatsapp", "phone_required"));
  }
}

/**
 * Screens a listing: hard blockers (422), soft flags, risk score and resulting state. Same input,
 * same output: no clock, no randomness, no I/O.
 */
export function screenListing(input: ScreenInput, ctx: ScreenContext): ScreenResult {
  const blockers: FieldIssue[] = [];
  const flags = new Set<ModerationFlag>();
  const risk = ctx.abuse?.risk ?? DEFAULT_RISK_RULES;
  const evidence: string[] = [];
  const note = (text: string) => {
    if (!evidence.includes(text)) evidence.push(text);
  };

  // Step 1: tree, criteria, price rules; contact rules.
  checkTree(input, blockers);
  checkContact(input, blockers);

  // Adults-only subcategory: a moderator reviews every version before it goes public.
  const adultsOnly = Boolean(subcategoryById(input.subcategoryId)?.adultsOnly);
  if (adultsOnly) {
    flags.add("restricted_category");
    note(`adults-only subcategory ${input.subcategoryId}`);
  }

  // Food from producers: a moderator checks an ONSSA number the first time the shop uses it.
  const sanitary = sanitaryNumber(input.subcategoryId, input.attributes ?? {});
  if (sanitary && !(input.seller.sanitaryNumbers ?? []).includes(sanitary)) {
    flags.add("sanitary_check");
    note(`ONSSA number ${sanitary} not yet checked for this shop`);
  }

  // Steps 2-3 on every free text: phones, e-mails / links, prohibited keywords, sensitive data.
  const phoneKeys = new Set<string>();
  for (const field of textFields(input)) {
    const phones = findPhoneNumbers(field.text);
    if (phones.length > 0) {
      pushIssue(blockers, issue(field.path, "phone_in_text"));
      note(`phone pattern in ${field.path}`);
      for (const phone of phones) phoneKeys.add(phone.e164 ?? phone.raw.replace(/\D/g, ""));
    }
    for (const contact of findContacts(field.text)) {
      pushIssue(blockers, issue(field.path, contact.kind === "email" ? "email_in_text" : "url_in_text"));
      note(`${contact.kind} in ${field.path}`);
    }
    const prohibited = containsProhibited(field.text, ctx.abuse?.prohibited);
    if (prohibited.hard.length > 0) {
      pushIssue(blockers, issue(field.path, "prohibited"));
      flags.add("prohibited_kw");
      for (const group of prohibited.hard) note(`prohibited hard:${group} in ${field.path}`);
    }
    for (const group of prohibited.soft) {
      // Dagger words are expected in the adults-only subcategory: noted for the moderator, no flag.
      if (!(adultsOnly && group === "weapons")) flags.add("prohibited_soft");
      note(`prohibited soft:${group} in ${field.path}`);
    }
    const sensitive = detectSensitiveDetailed(field.text);
    if (sensitive.length > 0) {
      flags.add("sensitive_text");
      for (const hit of sensitive) note(`sensitive ${hit.evidence} in ${field.path}`);
    }
  }
  // Credit advertising (loi 31-08 art. 76): an instalment without the TEG goes to a moderator. Rent per
  // month or night is not credit: rentals are skipped.
  if (!subcategoryById(input.subcategoryId)?.priceUnit && quotesCreditWithoutApr(`${input.title ?? ""}\n${input.description ?? ""}`)) {
    flags.add("credit_ad");
    note("instalment quoted without TEG");
  }
  // Car rental: with driver, identity paper or blank cheque as a guarantee, old vehicle -> a moderator.
  const rental = rentalReviewReasons(input, ctx.now ?? new Date());
  if (rental.length > 0) {
    flags.add("rental_review");
    for (const reason of rental) note(reason);
  }
  // Simple rule (documented limit): a second distinct number is treated as a third party's.
  if (phoneKeys.size >= 2) {
    flags.add("third_party_phone");
    note(`${phoneKeys.size} distinct phone numbers in text`);
  }

  // Step 5 outcomes carried by the photos: faces, nudity in the review band (a rejected photo never gets here).
  input.photos.forEach((photo, index) => {
    const checks = photo.checks;
    if (!checks) return;
    if ((checks.faces ?? 0) >= 1) {
      flags.add("face");
      note(`face on photo ${index + 1}`);
    }
    if (checks.nsfw !== undefined && checks.nsfw >= ctx.ai.nsfw.reviewAt) {
      flags.add("nsfw_review");
      note(`nsfw ${checks.nsfw.toFixed(2)} on photo ${index + 1}${checks.nsfw >= ctx.ai.nsfw.rejectAt ? " (above reject threshold)" : ""}`);
    }
  });

  // Step 4: price, duplicates, account age, volume.
  if (input.price !== null && !input.isDonation && isPriceOutlier(input.price, input.subcategoryId)) {
    const range = priceRange(input.subcategoryId);
    flags.add("price_outlier");
    note(`price ${input.price} outside ${range?.min ?? "?"}-${range?.max ?? "?"} (${input.subcategoryId})`);
  }
  if ((input.duplicates?.sameText ?? 0) > 0) {
    flags.add("dup_text");
    note(`same text as ${input.duplicates?.sameText} listing(s)`);
  }
  if ((input.duplicates?.samePhoto ?? 0) > 0) {
    flags.add("dup_photo");
    note(`same photo as ${input.duplicates?.samePhoto} listing(s)`);
  }
  if (input.seller.accountAgeDays < risk.newAccountDays) {
    flags.add("new_account");
    note(`account age ${input.seller.accountAgeDays} day(s)`);
  }
  if (input.seller.listingsLast24h >= risk.volumePerDay) {
    flags.add("volume");
    note(`${input.seller.listingsLast24h} listings in 24h`);
  }
  if (input.seller.previousRejections > 0) note(`${input.seller.previousRejections} previous rejection(s)`);
  if (input.sensitiveDeclaration) note(`declaration ${input.sensitiveDeclaration.kind}`);

  const sorted = sortFlags(flags);
  const { score } = riskScore(sorted, { previousRejections: input.seller.previousRejections }, risk);
  const state = decideState(score, sorted, { reviewAt: ctx.ai.risk.reviewAt });
  return { state, score, flags: sorted, blockers, evidence };
}
