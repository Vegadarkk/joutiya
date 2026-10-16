import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { launchOfferOpen, listingQuotas } from "@/config/pricing";
import type { StaffContext } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { getFlags, getPricing } from "@/lib/config/runtime";
import type { ProDecisionInput, ProDecisionResponse, ProQueueItem, ProQueueResponse, ProReview } from "@/lib/contracts/pro";
import { getProProfile, listProApplications, proProfileFromSnapshot, proProfileRef, proProfileToFirestore, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { getUploads } from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { updateClaims } from "@/lib/firebase/claims";
import { HttpError, notFound } from "@/lib/http/errors";
import { getLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { listingRecipient } from "@/lib/mail/recipients";
import { consume } from "@/lib/quota";
import type { RequestIdentity } from "@/lib/rate-limit/keys";
import { IllegalProTransitionError, transition } from "./lifecycle";
import type { ProProfileDoc } from "./profile-schema";
import { retagOwnerListings } from "./retag";

// KYBC review of the back office (phase 7 design §4): the queue of submitted applications, one
// application's review, and the moderator's decision. The decision is one transaction that
// re-reads the profile and the owner's account (a resubmission or another moderator meanwhile
// answers 409) and writes both; the claims, the listings retag, the audit entry and the mail
// follow the commit. Verify: claims role pro + proId + proRole owner (sessions revoked),
// users.type "pro", lifecycle verified with the launch offer's Essentiel quotas when it is open.
// Reject: lifecycle rejected with the moderator's reason; the account stays individual.

export const PRO_QUEUE_PAGE = 50;

const iso = (date: Date | undefined) => (date ? date.toISOString() : null);

export async function proQueue(): Promise<ProQueueResponse> {
  const records = await listProApplications("submitted", PRO_QUEUE_PAGE + 1);
  const page = records.slice(0, PRO_QUEUE_PAGE);
  const owners = await Promise.all(page.map((record) => getUserRecord(record.ownerUid)));
  const items: ProQueueItem[] = page.map((record, index) => {
    const owner = owners[index];
    return {
      proId: record.proId,
      name: record.name,
      legalForm: record.legal.form,
      citySlug: record.citySlug,
      ice: record.legal.ice,
      iceFormatOk: record.kybc.iceFormatOk,
      pieces: record.kybc.uploadIds.length,
      owner: owner ? { displayName: owner.displayName, publicId: owner.publicId } : null,
      submittedAt: (record.kybc.submittedAt ?? record.updatedAt).toISOString(),
    };
  });
  return { items, hasMore: records.length > PRO_QUEUE_PAGE };
}

export async function proReview(proId: string): Promise<ProReview | null> {
  const record = await getProProfile(proId);
  if (!record) return null;
  const [owner, pieces] = await Promise.all([getUserRecord(record.ownerUid), getUploads(record.kybc.uploadIds)]);
  const { form, ...identifiers } = record.legal;
  return {
    proId: record.proId,
    name: record.name,
    slug: record.slug,
    description: record.description,
    regionCode: record.regionCode,
    citySlug: record.citySlug,
    legal: { form, ...Object.fromEntries(Object.entries(identifiers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) },
    kybc: {
      status: record.kybc.status,
      iceFormatOk: record.kybc.iceFormatOk,
      submittedAt: iso(record.kybc.submittedAt),
      rejectReason: record.kybc.rejectReason ?? null,
      registrySource: record.kybc.registryCheck?.source ?? null,
    },
    lifecycle: record.lifecycle,
    plan: record.plan,
    planSource: record.planSource,
    owner: owner
      ? {
          uid: owner.uid,
          displayName: owner.displayName,
          publicId: owner.publicId,
          status: owner.status,
          emailVerified: owner.badges.emailVerified,
          phoneVerified: owner.badges.phoneVerified,
          createdAt: owner.createdAt.toISOString(),
        }
      : null,
    pieces: pieces.map((upload) => ({ id: upload.id, status: upload.status, declaredType: upload.declaredType, size: upload.size ?? null })),
  };
}

/** The profile after the decision: pure, so the unit tests cover every branch without Firestore. */
export function decidedProfile(current: ProProfileRecord, input: ProDecisionInput, ctx: { staffUid: string; now: Date; launchOfferActive: boolean; pricing: Awaited<ReturnType<typeof getPricing>> }): ProProfileDoc {
  if (current.kybc.status !== "submitted" || current.lifecycle !== "pending_verification") throw new HttpError(409, "conflict", "application already decided");
  if (!current.kybc.submittedAt || current.kybc.submittedAt.getTime() !== Date.parse(input.submittedAt)) throw new HttpError(409, "conflict", "application resubmitted since the review");
  const { proId: _proId, ...doc } = current;
  let result;
  try {
    result = transition(current, input.action === "verify" ? { type: "kybc_verified", launchOfferActive: ctx.launchOfferActive } : { type: "kybc_rejected" }, { now: ctx.now, graceDays: ctx.pricing.graceDays });
  } catch (error) {
    if (error instanceof IllegalProTransitionError) throw new HttpError(409, "conflict", error.message);
    throw error;
  }
  const { patch } = result;
  const kybc: ProProfileDoc["kybc"] =
    input.action === "verify"
      ? { ...doc.kybc, status: "verified", registryCheck: { source: input.registrySource, at: ctx.now, by: ctx.staffUid }, rejectReason: undefined }
      : { ...doc.kybc, status: "rejected", rejectReason: input.reason };
  return {
    ...doc,
    kybc,
    lifecycle: patch.lifecycle,
    plan: patch.plan,
    planSource: patch.planSource,
    quotas: listingQuotas({ type: "pro", plan: patch.plan }, ctx.pricing),
    updatedAt: ctx.now,
  };
}

export async function decideApplication(staff: StaffContext, proId: string, input: ProDecisionInput, identity: RequestIdentity, now = new Date()): Promise<ProDecisionResponse> {
  const [pricing, flags] = await Promise.all([getPricing(), getFlags()]);
  // Sales open: no launch offer, whatever config/pricing still says (design D3).
  const launchOfferActive = !flags.salesEnabled && launchOfferOpen(pricing.launchOffer, now);
  const ref = proProfileRef(proId);

  const decided = await db().runTransaction(async (tx) => {
    const current = proProfileFromSnapshot(await tx.get(ref));
    if (!current) throw notFound();
    const userRef = db().collection(COLLECTIONS.users).doc(current.ownerUid);
    const userSnapshot = await tx.get(userRef);
    if (!userSnapshot.exists) throw new HttpError(409, "conflict", "owner account missing");
    if (userSnapshot.get("proId") !== proId) throw new HttpError(409, "conflict", "owner account linked to another shop");
    if (input.action === "verify" && userSnapshot.get("status") !== "active") throw new HttpError(409, "account_suspended", "owner account not active");
    const next = decidedProfile(current, input, { staffUid: staff.user.uid, now, launchOfferActive, pricing });
    tx.set(ref, proProfileToFirestore(next));
    if (input.action === "verify") tx.update(userRef, { type: "pro", updatedAt: Timestamp.fromDate(now) });
    return { previous: current, next };
  });
  void consume("firestore.reads", 2);
  void consume("firestore.writes", input.action === "verify" ? 2 : 1);

  const uid = decided.next.ownerUid;
  let retagged = 0;
  if (input.action === "verify") {
    // Sessions are revoked: the owner signs in again and gets the Pro claims.
    await updateClaims(uid, { role: "pro", proId, proRole: "owner" });
    try {
      retagged = (await retagOwnerListings(uid, proId, now)).retagged;
    } catch (error) {
      // The profile and claims are right; a later run of the retag (idempotent) finishes the listings.
      logger.error({ err: (error as Error).message, proId }, "pro listings retag failed");
    }
  }

  await audit({
    actorUid: staff.user.uid,
    actorRole: staff.role,
    action: input.action === "verify" ? "pro.verify" : "pro.reject",
    target: { type: "pro", id: proId },
    automated: false,
    ...(input.action === "reject" ? { reason: input.reason.slice(0, 500) } : {}),
    ip: identity.ip,
    at: now,
  });
  await notifyApplicant(decided.next, input, launchOfferActive ? pricing.launchOffer.noticeDays : null);
  return { proId, lifecycle: decided.next.lifecycle, retagged };
}

/** proApproved / proRejected; a failure is logged, never thrown (the decision is committed). */
async function notifyApplicant(profile: ProProfileDoc, input: ProDecisionInput, noticeDays: number | null): Promise<void> {
  try {
    const to = await listingRecipient(profile.ownerUid);
    if (!to) return;
    const base = { locale: to.locale, to: to.email, priority: "transactional" as const };
    const key = `${input.action}-${profile.ownerUid}-${input.submittedAt}`.replace(/[^A-Za-z0-9_-]/g, "");
    if (input.action === "verify") {
      await sendMail({ ...base, template: "proApproved", idempotencyKey: `proApproved-${key}`, data: { displayName: to.displayName, shopName: profile.name, launchOffer: noticeDays !== null, noticeDays: noticeDays ?? 0 } });
    } else {
      const contact = (await getLegalConfig()).dsaContactEmail;
      await sendMail({ ...base, template: "proRejected", idempotencyKey: `proRejected-${key}`, data: { displayName: to.displayName, shopName: profile.name, reason: input.reason, contact } });
    }
  } catch (error) {
    logger.error({ err: (error as Error).message, template: input.action }, "pro decision mail failed");
  }
}
