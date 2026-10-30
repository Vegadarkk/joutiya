import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { launchOfferOpen, listingQuotas } from "@/config/pricing";
import type { StaffContext } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { getFlags, getPricing } from "@/lib/config/runtime";
import type { ProDecisionInput, ProDecisionResponse, ProPhoneCheckInput, ProPhoneCheckResponse, ProQueueItem, ProQueueResponse, ProReview } from "@/lib/contracts/pro";
import { getProProfile, listProApplications, proProfileFromSnapshot, proProfileRef, proProfileToFirestore, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { getUploads } from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { getLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { listingRecipient } from "@/lib/mail/recipients";
import { claimVerifiedPhoneIn } from "@/lib/phone-verify/accounts";
import { notifyPhoneChange } from "@/lib/phone-verify/notify";
import { normalizeMoroccanMobile } from "@/lib/phone/normalize";
import { consume } from "@/lib/quota";
import type { RequestIdentity } from "@/lib/rate-limit/keys";
import { applyVerificationEffects, hasProClaims } from "./effects";
import { KYBC_END_RETENTION_MS } from "./kybc-retention";
import { IllegalProTransitionError, publishesAsPro, transition } from "./lifecycle";
import type { ProProfileDoc } from "./profile-schema";
import { rentalCheckReview } from "./rental-check";

// KYBC review of the back office (phase 7 design §4): the queue of submitted applications, one
// application's review, and the moderator's decision. The decision is one transaction that
// re-reads the profile and the owner's account (a resubmission or another moderator meanwhile
// answers 409) and writes both; the audit entry and the mail follow the commit whatever happens
// to the effects. Verify: claims role pro + proId + proRole owner (sessions revoked), users.type
// "pro", lifecycle verified with the launch offer's Essentiel quotas when it is open; the claims
// and the listings retag are the effects of src/lib/pro/effects.ts, rerun by the nightly sync or
// by the same verify request again when they failed. Reject: lifecycle rejected with the
// moderator's reason, the account stays individual, the profile and its pieces purge 6 months on.
// Verify needs the owner's number verified: by WhatsApp before the application, or, while that
// check is unavailable, by the moderator's call recorded with checkPhoneByCall.

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
    sector: record.sector ?? "general",
    legal: { form, ...Object.fromEntries(Object.entries(identifiers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) },
    kybc: {
      status: record.kybc.status,
      iceFormatOk: record.kybc.iceFormatOk,
      submittedAt: iso(record.kybc.submittedAt),
      rejectReason: record.kybc.rejectReason ?? null,
      registrySource: record.kybc.registryCheck?.source ?? null,
      phoneCheck: record.kybc.phoneCheck
        ? { at: record.kybc.phoneCheck.at.toISOString(), by: record.kybc.phoneCheck.by, outcome: record.kybc.phoneCheck.outcome, phone: record.kybc.phoneCheck.phone, note: record.kybc.phoneCheck.note ?? null }
        : null,
    },
    lifecycle: record.lifecycle,
    plan: record.plan,
    planSource: record.planSource,
    effectsPending: record.effectsPendingSince !== undefined,
    owner: owner
      ? {
          uid: owner.uid,
          displayName: owner.displayName,
          publicId: owner.publicId,
          status: owner.status,
          emailVerified: owner.badges.emailVerified,
          phoneVerified: owner.badges.phoneVerified,
          phoneToCheck: record.kybc.phoneToCheck ?? null,
          createdAt: owner.createdAt.toISOString(),
        }
      : null,
    pieces: pieces.map((upload) => ({ id: upload.id, status: upload.status, declaredType: upload.declaredType, size: upload.size ?? null })),
    rentalCheck: await rentalCheckReview(record),
  };
}

/** The profile after the decision: pure, so the unit tests cover every branch without Firestore. */
export function decidedProfile(current: ProProfileRecord, input: ProDecisionInput, ctx: { staffUid: string; now: Date; launchOfferActive: boolean; pricing: Awaited<ReturnType<typeof getPricing>> }): ProProfileDoc {
  if (current.kybc.status !== "submitted" || current.lifecycle !== "pending_verification") throw new HttpError(409, "conflict", "application already decided");
  if (!reviewedSubmission(current, input)) throw new HttpError(409, "conflict", "application resubmitted since the review");
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
      ? { ...doc.kybc, status: "verified", registryCheck: { source: input.registrySource, at: ctx.now, by: ctx.staffUid }, rejectReason: undefined, phoneToCheck: undefined }
      : { ...doc.kybc, status: "rejected", rejectReason: input.reason };
  return {
    ...doc,
    kybc,
    lifecycle: patch.lifecycle,
    plan: patch.plan,
    planSource: patch.planSource,
    quotas: listingQuotas({ type: "pro", plan: patch.plan }, ctx.pricing),
    // A rejected application keeps its identifiers and pieces 6 months (spec §7), then retention-purge deletes it.
    purgeAt: input.action === "reject" ? new Date(ctx.now.getTime() + KYBC_END_RETENTION_MS) : undefined,
    effectsPendingSince: undefined,
    updatedAt: ctx.now,
  };
}

/** The moderator reviewed this very submission (a resubmission meanwhile changes `submittedAt`). */
function reviewedSubmission(current: Pick<ProProfileRecord, "kybc">, input: Pick<ProDecisionInput, "submittedAt">): boolean {
  return current.kybc.submittedAt !== undefined && current.kybc.submittedAt.getTime() === Date.parse(input.submittedAt);
}

/** A verify of a submission already verified: its effects are rerun instead of answering 409. */
export function isEffectsRerun(current: Pick<ProProfileRecord, "kybc" | "lifecycle">, input: ProDecisionInput): boolean {
  return input.action === "verify" && current.kybc.status === "verified" && publishesAsPro(current.lifecycle) && reviewedSubmission(current, input);
}

export async function decideApplication(staff: StaffContext, proId: string, input: ProDecisionInput, identity: RequestIdentity, now = new Date()): Promise<ProDecisionResponse> {
  const [pricing, flags] = await Promise.all([getPricing(), getFlags()]);
  // Sales open: no launch offer, whatever config/pricing still says (design D3).
  const launchOfferActive = !flags.salesEnabled && launchOfferOpen(pricing.launchOffer, now);
  const ref = proProfileRef(proId);

  const decided = await db().runTransaction(async (tx) => {
    const current = proProfileFromSnapshot(await tx.get(ref));
    if (!current) throw notFound();
    if (isEffectsRerun(current, input)) return { next: current, rerun: true };
    const userRef = db().collection(COLLECTIONS.users).doc(current.ownerUid);
    const userSnapshot = await tx.get(userRef);
    if (!userSnapshot.exists) throw new HttpError(409, "conflict", "owner account missing");
    if (userSnapshot.get("proId") !== proId) throw new HttpError(409, "conflict", "owner account linked to another shop");
    if (input.action === "verify" && userSnapshot.get("status") !== "active") throw new HttpError(409, "account_suspended", "owner account not active");
    if (input.action === "verify" && userSnapshot.get("badges.phoneVerified") !== true) throw new HttpError(409, "phone_unverified", "owner phone not verified");
    const next = decidedProfile(current, input, { staffUid: staff.user.uid, now, launchOfferActive, pricing });
    tx.set(ref, proProfileToFirestore(next));
    if (input.action === "verify") tx.update(userRef, { type: "pro", updatedAt: Timestamp.fromDate(now) });
    return { next, rerun: false };
  });
  void consume("firestore.reads", decided.rerun ? 1 : 2);
  if (!decided.rerun) void consume("firestore.writes", input.action === "verify" ? 2 : 1);

  const uid = decided.next.ownerUid;
  if (decided.rerun) {
    // Nothing left to do: the same answer as a second decision on a decided application.
    if (decided.next.effectsPendingSince === undefined && (await hasProClaims(uid, proId))) throw new HttpError(409, "conflict", "application already decided");
    const outcome = await applyVerificationEffects(uid, proId, now);
    await audit({ actorUid: staff.user.uid, actorRole: staff.role, action: "pro.verify.rerun", target: { type: "pro", id: proId }, automated: false, reason: outcome.ok ? "effects applied" : "effects still pending", ip: identity.ip, at: now });
    return { proId, lifecycle: decided.next.lifecycle, retagged: outcome.retagged, effectsPending: !outcome.ok };
  }

  let effectsPending = false;
  let retagged = 0;
  if (input.action === "verify") {
    const outcome = await applyVerificationEffects(uid, proId, now);
    retagged = outcome.retagged;
    effectsPending = !outcome.ok;
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
  return { proId, lifecycle: decided.next.lifecycle, retagged, effectsPending };
}

/**
 * The moderator called the applicant's number (while the WhatsApp check is unavailable): the
 * outcome is recorded on the application (who, when, which number) and journaled; `verified`
 * also marks the number verified on the account in the same transaction, taking it from any
 * other account that held it like the WhatsApp path (both told by e-mail).
 */
export async function checkPhoneByCall(staff: StaffContext, proId: string, input: ProPhoneCheckInput, identity: RequestIdentity, now = new Date()): Promise<ProPhoneCheckResponse> {
  const ref = proProfileRef(proId);
  const corrected = input.phone === undefined ? null : normalizeMoroccanMobile(input.phone).e164;
  const checked = await db().runTransaction(async (tx) => {
    const current = proProfileFromSnapshot(await tx.get(ref));
    if (!current) throw notFound();
    if (current.kybc.status !== "submitted" || current.lifecycle !== "pending_verification") throw new HttpError(409, "conflict", "application not under review");
    const userRef = db().collection(COLLECTIONS.users).doc(current.ownerUid);
    const userSnapshot = await tx.get(userRef);
    if (!userSnapshot.exists || userSnapshot.get("proId") !== proId) throw new HttpError(409, "conflict", "owner account missing or linked to another shop");
    if (userSnapshot.get("status") !== "active") throw new HttpError(409, "account_suspended", "owner account not active");
    const badge = userSnapshot.get("badges.phoneVerified") === true;
    const verified = input.outcome === "verified";
    if (verified && badge) throw new HttpError(409, "conflict", "phone already verified");
    const phone = corrected ?? current.kybc.phoneToCheck;
    if (!phone) throw new HttpError(400, "phone_required", "no number to check");
    // Reads first (the claim queries the holders), then the writes.
    const claimed = verified ? await claimVerifiedPhoneIn(tx, current.ownerUid, phone, now) : { previousUid: null, moved: 0 };
    const phoneCheck = { at: Timestamp.fromDate(now), by: staff.user.uid, outcome: input.outcome, phone, ...(input.note ? { note: input.note } : {}) };
    tx.update(ref, { "kybc.phoneCheck": phoneCheck, ...(verified ? { "kybc.phoneToCheck": FieldValue.delete() } : {}), updatedAt: Timestamp.fromDate(now) });
    return { ownerUid: current.ownerUid, phone, verified, phoneVerified: badge || verified, previousUid: claimed.previousUid, moved: claimed.moved };
  });
  void consume("firestore.reads", 2);
  void consume("firestore.writes", 1 + (checked.verified ? 2 + 2 * checked.moved : 0));

  const entry = { actorUid: staff.user.uid, actorRole: staff.role, automated: false, ip: identity.ip, at: now };
  await audit({ ...entry, action: "pro.phone.check", target: { type: "pro", id: proId }, reason: input.outcome });
  if (checked.verified) {
    await audit({ ...entry, action: "phone.verified", target: { type: "user", id: checked.ownerUid }, reason: "call during the KYBC review" });
    const key = `${proId}-${now.getTime()}`;
    if (checked.previousUid) {
      await audit({ ...entry, action: "phone.transferred", target: { type: "user", id: checked.previousUid }, reason: `number verified by ${checked.ownerUid}` });
      await notifyPhoneChange("phoneRemoved", checked.previousUid, checked.phone, key);
    }
    await notifyPhoneChange("phoneVerified", checked.ownerUid, checked.phone, key);
  }
  return { proId, outcome: input.outcome, phoneVerified: checked.phoneVerified, transferred: checked.previousUid !== null };
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
