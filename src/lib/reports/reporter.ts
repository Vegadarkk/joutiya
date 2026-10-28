import "server-only";
import type { AiConfig } from "@/config/ai";
import { aiConfig } from "@/lib/ai/config";
import { audit } from "@/lib/audit";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import { COLLECTIONS, userPrivateSchema, type UserPrivateDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { applyReporterOutcome, trustedFromFacts, type ReporterOutcome, type ReporterStats } from "./rules";

// Reporter accuracy (art. 23 DSA, design D11 "trusted", D15): `users/{uid}/private/account.reporter`
// keeps the last 10 outcomes, the total, the dates of manifestly unfounded reports, the prior
// warning and the suspension of the reports. Written only when a decision closes reports.

export const privateAccountRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc);

/** The private account document with Dates, or null (missing or malformed). */
export async function readPrivateAccount(uid: string): Promise<UserPrivateDoc | null> {
  const snapshot = await privateAccountRef(uid).get();
  void consume("firestore.reads", 1);
  const data = snapshot.data();
  if (!data) return null;
  const parsed = userPrivateSchema.safeParse(timestampsToDates(data));
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues.length }, "reports: private account document does not match its schema");
    return null;
  }
  return parsed.data;
}

/**
 * D11 "trusted" reporter: a trusted flagger of config/ai, or an active account of at least 30 days
 * with a verified phone, at least 5 decided reports among its last 10 and at least 80 % founded.
 */
export async function isTrustedReporter(uid: string, now = new Date(), options: { ai?: AiConfig; account?: UserPrivateDoc | null } = {}): Promise<boolean> {
  const ai = options.ai ?? (await aiConfig());
  if (ai.trustedFlaggers.includes(uid)) return true;
  const [user, account] = await Promise.all([getUserRecord(uid), options.account !== undefined ? Promise.resolve(options.account) : readPrivateAccount(uid)]);
  return trustedFromFacts({ user, reporter: account?.reporter ?? null, now });
}

export interface ReporterOutcomesResult {
  /** Reporters who just reached 3 manifestly unfounded reports in 30 days: send `reporterWarning` (L3). */
  warned: string[];
  /** Reporters whose reports are refused for 30 days from now (art. 23(2)). */
  suspended: string[];
}

/**
 * Records the outcomes of decided reports on their reporters (D15), one transaction per account:
 * the last 10 outcomes and the total, then art. 23 (prior warning, then 30 days of refused reports).
 * Accounts without a private document (closed and purged) are skipped. Mails are the caller's.
 */
export async function recordReporterOutcomes(outcomes: readonly ReporterOutcome[], now = new Date()): Promise<ReporterOutcomesResult> {
  const byUid = new Map<string, ReporterOutcome[]>();
  for (const outcome of outcomes) byUid.set(outcome.uid, [...(byUid.get(outcome.uid) ?? []), outcome]);
  const result: ReporterOutcomesResult = { warned: [], suspended: [] };
  for (const [uid, list] of byUid) {
    const update = await db().runTransaction(async (tx) => {
      const snapshot = await tx.get(privateAccountRef(uid));
      void consume("firestore.reads", 1);
      const data = snapshot.data();
      if (!data) return null;
      const parsed = userPrivateSchema.shape.reporter.safeParse(timestampsToDates(data["reporter"]));
      let reporter: ReporterStats | null = parsed.success ? parsed.data : null;
      let warn = false;
      let abusive = false;
      for (const outcome of list) {
        const next = applyReporterOutcome(reporter, outcome, now);
        reporter = next.reporter;
        warn ||= next.warn;
        abusive ||= next.abusive;
      }
      if (!reporter) return null;
      tx.update(privateAccountRef(uid), { reporter: datesToTimestamps(userPrivateSchema.shape.reporter.parse(reporter)) });
      void consume("firestore.writes", 1);
      return { warn, abusive };
    });
    if (!update) continue;
    if (update.warn) result.warned.push(uid);
    if (update.abusive) result.suspended.push(uid);
    if (update.warn || update.abusive) {
      await audit({
        actorUid: "system",
        actorRole: "system",
        action: update.abusive ? "reporter.suspend" : "reporter.warn",
        target: { type: "user", id: uid },
        automated: true,
        reason: update.abusive ? "art. 23: manifestly unfounded reports after a warning" : "art. 23: 3 manifestly unfounded reports in 30 days",
        at: now,
      });
    }
  }
  return result;
}
