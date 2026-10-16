import "server-only";
import { listingQuotas } from "@/config/pricing";
import type { AuthContext } from "@/lib/auth/guards";
import { getFlags, getPricing } from "@/lib/config/runtime";
import type { ProApplyInput, ProMeResponse } from "@/lib/contracts/pro";
import { db } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { countActive } from "@/lib/db/repositories/listings";
import { getProProfile, proProfileFromSnapshot, proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { getUploads } from "@/lib/db/repositories/uploads";
import { getUser } from "@/lib/db/repositories/users";
import { HttpError } from "@/lib/http/errors";
import { newListingId, slugify } from "@/lib/listings/ids";
import { consume } from "@/lib/quota";
import { iceFormatOk } from "./kybc";
import { storefrontShown, transition } from "./lifecycle";
import type { ProProfileDoc } from "./profile-schema";

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
 * Submits (or, after a rejection, resubmits) the application. Refuses: applications closed
 * (`config/flags.proSignupEnabled`), an account already Pro, an application in progress, an
 * unverified e-mail or phone, pieces that are not the applicant's `kyb` uploads.
 */
export async function submitApplication(actor: ProActor, input: ProApplyInput, now = new Date()): Promise<{ proId: string }> {
  const uid = actor.auth.user.uid;
  const flags = await getFlags();
  if (!flags.proSignupEnabled) throw new HttpError(403, "pro_signup_closed");
  if (actor.auth.user.claims.role === "pro") throw new HttpError(409, "already_pro");

  const user = await getUser(uid);
  if (!user || user.status !== "active") throw new HttpError(403, "account_suspended");
  if (!user.badges.emailVerified) throw new HttpError(403, "email_not_verified");
  if (!user.badges.phoneVerified) throw new HttpError(403, "phone_required");

  const pieces = await getUploads(input.uploadIds);
  const valid = pieces.filter((upload) => upload.ownerUid === uid && upload.purpose === "kyb" && upload.status === "ready");
  if (valid.length !== new Set(input.uploadIds).size) throw new HttpError(400, "invalid_pieces");

  const existing = user.proId ? await getProProfile(user.proId) : null;
  if (existing && existing.lifecycle !== "rejected") throw new HttpError(409, "pro_application_exists");
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
  const [flags, user] = await Promise.all([getFlags(), getUser(uid)]);
  const eligibility = { emailVerified: user?.badges.emailVerified ?? false, phoneVerified: user?.badges.phoneVerified ?? false, accountActive: user?.status === "active" };
  const base = { signupOpen: flags.proSignupEnabled, salesOpen: flags.salesEnabled, eligibility };
  const profile = user?.proId ? await getProProfile(user.proId) : null;
  if (!profile || profile.ownerUid !== uid) return { ...base, shop: null };
  const pricing = await getPricing();
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
    },
  };
}
