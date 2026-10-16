import { criteriaSchema, subcategoryById } from "@/config/categories";
import { isPriceOutlier, priceRange } from "@/config/price-ranges";
import type { ModerationFlag } from "@/lib/contracts/listings";
import { findContacts } from "@/lib/moderation/contacts";
import { findPhoneNumbers } from "@/lib/moderation/phones";
import { containsProhibited } from "@/lib/moderation/prohibited";
import { NEW_ACCOUNT_DAYS, VOLUME_PER_DAY, decideState, riskScore, sortFlags } from "@/lib/moderation/risk";
import { detectSensitiveDetailed } from "@/lib/moderation/sensitive";
import type { FieldIssue, ScreenBlockerCode, ScreenContext, ScreenInput, ScreenResult } from "@/lib/moderation/types";

// Pre-publication screen (architecture §7 steps 1-5, design D8), pure and deterministic. The
// listing service calls it at publish (and when a published listing is edited):
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

/** Title, description, then the free-text attributes in key order. */
function textFields(input: ScreenInput): TextField[] {
  const fields: TextField[] = [
    { path: "title", text: input.title ?? "" },
    { path: "description", text: input.description ?? "" },
  ];
  for (const key of Object.keys(input.attributes ?? {}).sort()) {
    const value = input.attributes[key];
    if (typeof value === "string" && value.trim() !== "") fields.push({ path: `attributes.${key}`, text: value });
  }
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
  const evidence: string[] = [];
  const note = (text: string) => {
    if (!evidence.includes(text)) evidence.push(text);
  };

  // Step 1: tree, criteria, price rules; contact rules.
  checkTree(input, blockers);
  checkContact(input, blockers);

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
    const prohibited = containsProhibited(field.text);
    if (prohibited.hard.length > 0) {
      pushIssue(blockers, issue(field.path, "prohibited"));
      flags.add("prohibited_kw");
      for (const group of prohibited.hard) note(`prohibited hard:${group} in ${field.path}`);
    }
    if (prohibited.soft.length > 0) {
      flags.add("prohibited_soft");
      for (const group of prohibited.soft) note(`prohibited soft:${group} in ${field.path}`);
    }
    const sensitive = detectSensitiveDetailed(field.text);
    if (sensitive.length > 0) {
      flags.add("sensitive_text");
      for (const hit of sensitive) note(`sensitive ${hit.evidence} in ${field.path}`);
    }
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
  if (input.seller.accountAgeDays < NEW_ACCOUNT_DAYS) {
    flags.add("new_account");
    note(`account age ${input.seller.accountAgeDays} day(s)`);
  }
  if (input.seller.listingsLast24h >= VOLUME_PER_DAY) {
    flags.add("volume");
    note(`${input.seller.listingsLast24h} listings in 24h`);
  }
  if (input.seller.previousRejections > 0) note(`${input.seller.previousRejections} previous rejection(s)`);
  if (input.sensitiveDeclaration) note(`declaration ${input.sensitiveDeclaration.kind}`);

  const sorted = sortFlags(flags);
  const { score } = riskScore(sorted, { previousRejections: input.seller.previousRejections });
  const state = decideState(score, sorted, { reviewAt: ctx.ai.risk.reviewAt, categoryId: input.categoryId });
  return { state, score, flags: sorted, blockers, evidence };
}
