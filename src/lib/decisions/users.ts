import "server-only";
import { listDecisionsForUser } from "@/lib/db/repositories/moderation-decisions";
import { findUserByPublicId, getUserRecord } from "@/lib/db/repositories/profiles";
import type { UserModerationView } from "./contracts";
import { nextStep } from "./ladder";
import { getPrivate, getSuspension } from "./repository";

// Account view of the back office (design D14, D15, D24): status, strikes and the ladder's next
// step, the running suspension, the phone badge, reporter accuracy (art. 23) and the latest
// decisions. No e-mail, phone number or IP: the moderator decides on the account's conduct, not
// its identity.

const DAY_MS = 24 * 60 * 60 * 1000;
const MANIFEST_WINDOW_DAYS = 30;
export const USER_DECISIONS_LIMIT = 20;

export async function userModerationView(uid: string, now = new Date()): Promise<UserModerationView | null> {
  const user = await getUserRecord(uid);
  if (!user) return null;
  const [account, suspension, decisions] = await Promise.all([getPrivate(uid), getSuspension(uid), listDecisionsForUser(uid, USER_DECISIONS_LIMIT)]);
  const strikes = account?.strikes ?? { level: 0 as const };
  const reporter = account?.reporter;
  const recent = reporter?.recent ?? [];
  const windowStart = now.getTime() - MANIFEST_WINDOW_DAYS * DAY_MS;
  return {
    uid,
    publicId: user.publicId,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    strikes: { level: strikes.level, lastAt: strikes.lastAt?.toISOString() ?? null, suspendedUntil: strikes.suspendedUntil?.toISOString() ?? null },
    nextStep: nextStep(strikes.level),
    suspension: suspension ? { until: suspension.until.toISOString(), decisionId: suspension.decisionId } : null,
    phone: { verified: user.badges.phoneVerified, verifiedAt: account?.phoneVerifiedAt?.toISOString() ?? null },
    reporter: {
      total: reporter?.total ?? 0,
      recent: [...recent],
      foundedShare: recent.length > 0 ? Math.round((recent.filter(Boolean).length / recent.length) * 100) / 100 : null,
      manifestRecent: (reporter?.manifest ?? []).filter((at) => at.getTime() >= windowStart).length,
      warnedAt: reporter?.warnedAt?.toISOString() ?? null,
      abusiveUntil: reporter?.abusiveUntil && reporter.abusiveUntil.getTime() > now.getTime() ? reporter.abusiveUntil.toISOString() : null,
    },
    decisions: decisions.map((decision) => ({
      id: decision.id,
      action: decision.action,
      templateId: decision.templateId,
      target: { type: decision.target.type, id: decision.target.id },
      createdAt: decision.createdAt.toISOString(),
      appeal: decision.appeal?.status ?? null,
    })),
  };
}

/** The account behind a public profile id (back-office search), or null. */
export async function uidByPublicId(publicId: string): Promise<string | null> {
  return (await findUserByPublicId(publicId))?.uid ?? null;
}
