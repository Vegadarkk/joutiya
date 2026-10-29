import "server-only";
import { randomInt } from "node:crypto";
import { launchOfferOpen, listingQuotas } from "@/config/pricing";
import type { AuthContext } from "@/lib/auth/guards";
import { getFlags, getPricing } from "@/lib/config/runtime";
import type { SectionsInput, SectionsResponse, ShopSection } from "@/lib/contracts/catalog";
import type { ProAgencyInput, ProAgencyResponse, ProApplyInput, ProMeResponse, ProRentalInput, ProRentalResponse } from "@/lib/contracts/pro";
import { db } from "@/lib/firebase/admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { countActive } from "@/lib/db/repositories/listings";
import { getProProfile, proProfileFromSnapshot, proProfileRef, proProfileToFirestore, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS, type UserDoc } from "@/lib/db/schemas";
import { getUploads } from "@/lib/db/repositories/uploads";
import { getUser } from "@/lib/db/repositories/users";
import { HttpError } from "@/lib/http/errors";
import { newListingId, slugify } from "@/lib/listings/ids";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { firstStrictIssue } from "@/lib/moderation/free-text";
import { isPhoneVerificationConfigured } from "@/lib/phone-verify/config";
import { normalizeMoroccanMobile } from "@/lib/phone/normalize";
import { consume } from "@/lib/quota";
import { iceFormatOk, KYBC_NOTICE_VERSION } from "./kybc";
import { publishesAsPro, storefrontShown, transition } from "./lifecycle";
import type { ProProfileDoc } from "./profile-schema";
import { rentalCheckView } from "./rental-check-rules";

// Pro accounts (architecture §5 lifecycle, §6 "Devenir Pro", phase 7 design §4). The application
// creates proProfiles/{proId} in `pending_verification`; the account stays `individual` and
// publishes nothing as a Pro until a moderator validates the KYBC (verifyApplication, admin).
// `users/{uid}.proId` links the account to its shop from the application on (one shop per account
// at the MVP); the role and the claims change only at the verification.

export interface ProActor {
  auth: AuthContext;
  ip: string;
}

/** Shop id: same alphabet and length as a listing id, so `/boutique/{slug}-{proId}` reuses the slug helpers. */
export const newProId = newListingId;

/**
 * Eligibility of an application (and of sending its pieces): applications open
 * (`config/flags.proSignupEnabled`), an account not Pro yet, active, with a verified e-mail and
 * phone, and no application in progress for it (a rejected one may be resubmitted). While the
 * WhatsApp check is unavailable (Meta app pending), the phone is verified by a moderator's call
 * during the review instead: the application then carries the number to call.
 */
export async function assertCanApply(auth: AuthContext): Promise<{ user: UserDoc; existing: ProProfileRecord | null }> {
  const uid = auth.user.uid;
  const flags = await getFlags();
  if (!flags.proSignupEnabled) throw new HttpError(403, "pro_signup_closed");
  if (auth.user.claims.role === "pro") throw new HttpError(409, "already_pro");

  const user = await getUser(uid);
  if (!user || user.status !== "active") throw new HttpError(403, "account_suspended");
  if (!user.badges.emailVerified) throw new HttpError(403, "email_not_verified");
  if (!user.badges.phoneVerified && isPhoneVerificationConfigured()) throw new HttpError(403, "phone_required");

  const existing = user.proId ? await getProProfile(user.proId) : null;
  if (existing && existing.lifecycle !== "rejected") throw new HttpError(409, "pro_application_exists");
  return { user, existing };
}

/**
 * Submits (or, after a rejection, resubmits) the application. Refuses what `assertCanApply`
 * refuses, and pieces that are not the applicant's `kyb` uploads.
 */
export async function submitApplication(actor: ProActor, input: ProApplyInput, now = new Date()): Promise<{ proId: string }> {
  const uid = actor.auth.user.uid;
  const { user, existing } = await assertCanApply(actor.auth);
  // The badge may be false only while the WhatsApp check is unavailable: the number to call is then part of the application.
  let phoneToCheck: string | undefined;
  if (!user.badges.phoneVerified) {
    if (!input.phone) throw new HttpError(400, "phone_required");
    phoneToCheck = normalizeMoroccanMobile(input.phone).e164;
  }

  const pieces = await getUploads(input.uploadIds);
  const valid = pieces.filter((upload) => upload.ownerUid === uid && upload.purpose === "kyb" && upload.status === "ready");
  if (valid.length !== new Set(input.uploadIds).size) throw new HttpError(400, "invalid_pieces");

  const proId = existing?.proId ?? newProId();
  const pricing = await getPricing();

  const slug = slugify(`${input.name} ${input.citySlug.replace(/-/g, " ")}`) || "boutique";
  const doc: ProProfileDoc = {
    ownerUid: uid,
    members: { [uid]: "owner" },
    name: input.name,
    slug,
    description: input.description,
    whatsapp: false,
    regionCode: input.regionCode,
    citySlug: input.citySlug,
    legal: input.legal,
    kybc: {
      status: "submitted",
      iceFormatOk: iceFormatOk(input.legal.ice),
      uploadIds: [...new Set(input.uploadIds)],
      complianceCommitmentAt: now,
      noticeVersion: KYBC_NOTICE_VERSION,
      ...(phoneToCheck ? { phoneToCheck } : {}),
      submittedAt: now,
    },
    lifecycle: "pending_verification",
    plan: "none",
    planSource: "none",
    quotas: listingQuotas({ type: "pro", plan: "none" }, pricing),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) transition(existing, { type: "reapplied" }, { now, graceDays: pricing.graceDays });

  const ref = proProfileRef(proId);
  const userRef = db().collection(COLLECTIONS.users).doc(uid);
  // Two concurrent applications both read and write users/{uid}: Firestore serialises them and
  // the second one sees the first one's proId.
  await db().runTransaction(async (tx) => {
    const [userSnapshot, profileSnapshot] = await Promise.all([tx.get(userRef), tx.get(ref)]);
    const linked: unknown = userSnapshot.get("proId");
    if (linked !== undefined && linked !== proId) throw new HttpError(409, "pro_application_exists");
    const current = proProfileFromSnapshot(profileSnapshot);
    if (current && current.lifecycle !== "rejected") throw new HttpError(409, "pro_application_exists");
    tx.set(ref, proProfileToFirestore(doc));
    tx.update(userRef, { proId, updatedAt: Timestamp.fromDate(now) });
  });
  void consume("firestore.reads", 2);
  void consume("firestore.writes", 2);
  return { proId };
}

/** GET /api/pro/me: the account's shop or application, the switches and the eligibility checks. */
export async function proSelf(auth: AuthContext): Promise<ProMeResponse> {
  const uid = auth.user.uid;
  const [flags, user, pricing] = await Promise.all([getFlags(), getUser(uid), getPricing()]);
  const eligibility = { emailVerified: user?.badges.emailVerified ?? false, phoneVerified: user?.badges.phoneVerified ?? false, accountActive: user?.status === "active" };
  // The offer a shop verified today receives (as decideApplication grants it).
  const launchOffer = !flags.salesEnabled && launchOfferOpen(pricing.launchOffer, new Date()) ? { noticeDays: pricing.launchOffer.noticeDays } : null;
  const base = { signupOpen: flags.proSignupEnabled, salesOpen: flags.salesEnabled, phoneVerification: isPhoneVerificationConfigured() ? ("whatsapp" as const) : ("call" as const), launchOffer, eligibility };
  const profile = user?.proId ? await getProProfile(user.proId) : null;
  if (!profile || profile.ownerUid !== uid) return { ...base, shop: null };
  const active = profile.lifecycle === "pending_verification" || profile.lifecycle === "rejected" ? 0 : await countActive(uid);
  return {
    ...base,
    shop: {
      proId: profile.proId,
      name: profile.name,
      slug: profile.slug,
      description: profile.description,
      regionCode: profile.regionCode,
      citySlug: profile.citySlug,
      legalForm: profile.legal.form,
      ice: profile.legal.ice,
      lifecycle: profile.lifecycle,
      plan: profile.plan,
      planSource: profile.planSource,
      kybcStatus: profile.kybc.status,
      rejectReason: profile.kybc.rejectReason ?? null,
      submittedAt: profile.kybc.submittedAt?.toISOString() ?? null,
      quotas: profile.quotas,
      activeListings: active,
      launchOffer: profile.planSource === "launch_offer" ? { endsAt: pricing.launchOffer.endsAt, noticeDays: pricing.launchOffer.noticeDays } : null,
      storefront: storefrontShown(profile.lifecycle, profile.plan) ? `${profile.slug}-${profile.proId}` : null,
      sector: profile.sector ?? "general",
      feeSchedule: profile.agency?.feeSchedule ?? "",
      sections: profile.sections ?? [],
      rental: profile.rental ?? null,
      rentalCheck: profile.rentalCheck ? rentalCheckView(profile.rentalCheck) : null,
    },
  };
}

/**
 * PUT /api/pro/me/agency (Agence pack design §3): the owner sets the shop's sector and, for a
 * real-estate agency, its fee schedule. The owner of a verified shop that publishes (not
 * suspended), from the session claims; the storefront is revalidated when shown.
 */
export async function updateAgency(auth: AuthContext, input: ProAgencyInput, now = new Date()): Promise<ProAgencyResponse> {
  const profile = await ownedPublishingShop(auth);
  const feeSchedule = input.sector === "real_estate" ? input.feeSchedule : "";
  // The listing text rules, sensitive data refused outright (as a member's storefront bio).
  const issue = feeSchedule ? firstStrictIssue(feeSchedule) : null;
  if (issue) throw new HttpError(422, "invalid_text", "fee schedule refused by the text screen", { details: { field: "feeSchedule", issue } });
  await proProfileRef(profile.proId).update({
    sector: input.sector,
    agency: feeSchedule ? { feeSchedule } : FieldValue.delete(),
    updatedAt: Timestamp.fromDate(now),
  });
  void consume("firestore.reads", 1);
  void consume("firestore.writes", 1);
  if (storefrontShown(profile.lifecycle, profile.plan)) revalidateListingPaths({ shopSegment: `${profile.slug}-${profile.proId}` });
  return { sector: input.sector, feeSchedule };
}

const SECTION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const newSectionId = () => Array.from({ length: 6 }, () => SECTION_ID_ALPHABET[randomInt(SECTION_ID_ALPHABET.length)]).join("");

/**
 * PUT /api/pro/me/sections (catalogue §5): the storefront's sections, replaced whole in display
 * order. A section keeps its id (its listings stay in it); an unknown id is a new section; a
 * removed one leaves its listings' `sectionId` behind, ignored by every reader. Names pass the
 * storefront text screen.
 */
export async function updateSections(auth: AuthContext, input: SectionsInput, now = new Date()): Promise<SectionsResponse> {
  const profile = await ownedPublishingShop(auth);
  const known = new Set((profile.sections ?? []).map((section) => section.id));
  const used = new Set<string>();
  const sections: ShopSection[] = input.sections.map((section, index) => {
    const issue = firstStrictIssue(section.name);
    if (issue) throw new HttpError(422, "invalid_text", "section name refused by the text screen", { details: { field: `sections.${index}.name`, issue } });
    let id = section.id && known.has(section.id) && !used.has(section.id) ? section.id : newSectionId();
    while (used.has(id) || (id !== section.id && known.has(id))) id = newSectionId();
    used.add(id);
    return { id, name: section.name };
  });
  await proProfileRef(profile.proId).update({ sections: sections.length > 0 ? sections : FieldValue.delete(), updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.reads", 1);
  void consume("firestore.writes", 1);
  if (storefrontShown(profile.lifecycle, profile.plan)) revalidateListingPaths({ shopSegment: `${profile.slug}-${profile.proId}` });
  return { sections };
}

/** The owner's shop, verified and publishing (not suspended), from the session claims; else 409/403. */
export async function ownedPublishingShop(auth: AuthContext): Promise<ProProfileRecord> {
  const { proId, proRole } = auth.user.claims;
  if (!proId) throw new HttpError(409, "pro_not_verified");
  if (proRole !== "owner") throw new HttpError(403, "forbidden");
  const profile = await getProProfile(proId);
  if (!profile || profile.ownerUid !== auth.user.uid || !publishesAsPro(profile.lifecycle)) throw new HttpError(409, "pro_not_verified");
  return profile;
}

/**
 * PUT /api/pro/me/rental (rental pack §5): the car rental agency's settings, replaced whole. The
 * branch addresses and the hours pass the storefront text screen (no contact detail, prohibited
 * term or sensitive data); the storefront is revalidated when shown. A new licence reference drops
 * the document check made against the previous one (decision 5).
 */
export async function updateRentalAgency(auth: AuthContext, input: ProRentalInput, now = new Date()): Promise<ProRentalResponse> {
  const profile = await ownedPublishingShop(auth);
  const texts: [string, string][] = [["hours", input.hours], ...input.branches.map((branch, index): [string, string] => [`branches.${index}.address`, branch.address])];
  for (const [field, text] of texts) {
    const issue = text ? firstStrictIssue(text) : null;
    if (issue) throw new HttpError(422, "invalid_text", "rental settings refused by the text screen", { details: { field, issue } });
  }
  // The licence check was made against the previous reference: a new one needs a new document.
  const dropCheck = profile.rentalCheck !== undefined && profile.rentalCheck.agrementRef !== input.agrementRef;
  await proProfileRef(profile.proId).update({ rental: input, ...(dropCheck ? { rentalCheck: FieldValue.delete() } : {}), updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.reads", 1);
  void consume("firestore.writes", 1);
  if (storefrontShown(profile.lifecycle, profile.plan)) revalidateListingPaths({ shopSegment: `${profile.slug}-${profile.proId}` });
  return { rental: input };
}
