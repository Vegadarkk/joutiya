import { cguAccepted, cguEffectiveFor, LEGAL_VERSIONS } from "@/config/legal-versions";
import { listUserRecordsAfter } from "@/lib/db/repositories/profiles";
import { getUserPrivate, readCguNoticeCursor, recordCguNotice, writeCguNoticeCursor } from "@/lib/db/repositories/users";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { deliverMail, type DeliverOutcome } from "@/lib/mail/deliver";
import { headroom, isDegraded } from "@/lib/quota";

// Daily at 09:40 UTC (phase 6, D11; DSA art. 14 § 2): the cguChanged notice, at the lowest priority
// (bulk), to members who accepted an earlier CGU version, delivered here (deliverMail, the mail
// worker's own call) so that only a mail that left counts as the member's notice. The banner under the header tells
// signed-in members at once; this mail reaches the others. The accounts are visited once per CGU
// version in document id order: the cursor (system/cguNotice) holds the version and the last
// account visited, so a run capped by the mail budget resumes where it stopped and a finished
// version costs one read a day. Budget: CGU_NOTICE_MAX_MAILS a run, within what the saved-search
// digests (07:00) left under CGU_NOTICE_RESEND_SHARE of both Resend quotas; nothing is sent while
// a Resend quota is degraded. 40 a day reach 1 200 members within the 30-day notice (CGU §22.1),
// whose fallback covers the others: a mail that left records the member's first notice when the
// banner has not already done so (consents.cguNotice) and gives the day the version applies to
// them, 30 days after that notice when it came late (cguEffectiveFor). A mail that cannot leave
// (provider failure, quota) stops the run before that account, which the next run serves; a
// suppressed or rejected address is passed over: the banner notifies that member at sign-in.

export const CGU_NOTICE_MAX_MAILS = 40;
export const CGU_NOTICE_RESEND_SHARE = 0.6;
export const CGU_NOTICE_PAGE_SIZE = 100;
export const CGU_NOTICE_MAX_PAGES = 10;
const STOP_QUOTAS = ["resend.daily", "resend.monthly", "firestore.reads"] as const;

export interface CguNoticeResult {
  version: string;
  visited: number;
  mails: number;
  failed: number;
  /** Every account was visited for this version. */
  complete: boolean;
  stopped?: "quota" | "cap" | "pages" | "mail";
}

/** Mails this run may send: the per-run cap, and what is left under CGU_NOTICE_RESEND_SHARE of both quotas. */
export async function cguNoticeBudget(): Promise<number> {
  const [daily, monthly] = await Promise.all([headroom("resend.daily", CGU_NOTICE_RESEND_SHARE), headroom("resend.monthly", CGU_NOTICE_RESEND_SHARE)]);
  return Math.min(CGU_NOTICE_MAX_MAILS, daily ?? CGU_NOTICE_MAX_MAILS, monthly ?? CGU_NOTICE_MAX_MAILS);
}

async function quotaStop(): Promise<boolean> {
  return (await Promise.all(STOP_QUOTAS.map((id) => isDegraded(id)))).some(Boolean);
}

export async function sendCguNotices(now = new Date()): Promise<CguNoticeResult> {
  const { version } = LEGAL_VERSIONS.cgu;
  const result: CguNoticeResult = { version, visited: 0, mails: 0, failed: 0, complete: false };
  if (!isFirestoreConfigured()) {
    logger.warn("cgu-notice skipped: Firebase not configured");
    return result;
  }
  const stored = await readCguNoticeCursor();
  // A first run (no cursor) records the current version as done: members who signed up under it
  // need no notice, and accounts from before the cursor existed accepted a version it replaces.
  if (!stored) {
    await writeCguNoticeCursor({ version, lastUid: null, done: true }, now);
    return { ...result, complete: true };
  }
  if (stored.version === version && stored.done) return { ...result, complete: true };
  let lastUid = stored.version === version ? stored.lastUid : null;
  const budget = await cguNoticeBudget();

  for (let pages = 0; ; pages += 1) {
    if (pages >= CGU_NOTICE_MAX_PAGES) {
      result.stopped = "pages";
      break;
    }
    const page = await listUserRecordsAfter(lastUid, CGU_NOTICE_PAGE_SIZE);
    let stoppedInPage = false;
    for (const user of page.users) {
      if (result.mails >= budget) {
        result.stopped = "cap";
        stoppedInPage = true;
        break;
      }
      if (user.status !== "closed" && user.status !== "banned" && user.activation === "done") {
        try {
          const account = await getUserPrivate(user.uid);
          if (account?.email && !cguAccepted(account.consents?.cgu?.version)) {
            if (await quotaStop()) {
              result.stopped = "quota";
              stoppedInPage = true;
              break;
            }
            const notice = account.consents?.cguNotice;
            const noticeAt = notice?.version === version ? notice.at : null;
            let delivered: DeliverOutcome;
            try {
              delivered = await deliverMail({
                template: "cguChanged",
                locale: user.locale,
                to: account.email,
                data: { displayName: user.displayName, version, effective: cguEffectiveFor(noticeAt, now) },
                priority: "bulk",
                idempotencyKey: `cguChanged-${version}-${user.uid}`,
              });
            } catch (error) {
              logger.warn({ uid: user.uid, err: (error as Error).message }, "cgu notice not delivered");
              result.stopped = "mail";
              stoppedInPage = true;
              break;
            }
            if ("skipped" in delivered && delivered.skipped === "quota") {
              result.stopped = "quota";
              stoppedInPage = true;
              break;
            }
            if (!("skipped" in delivered)) {
              if (noticeAt === null) await recordCguNotice(user.uid, version, now);
              result.mails += 1;
            }
          }
        } catch (error) {
          result.failed += 1;
          logger.warn({ uid: user.uid, err: (error as Error).message }, "cgu notice failed");
        }
      }
      lastUid = user.uid;
      result.visited += 1;
    }
    if (stoppedInPage) break;
    // Unparsable documents are skipped but still move the cursor.
    if (page.lastUid) lastUid = page.lastUid;
    if (page.read < CGU_NOTICE_PAGE_SIZE) {
      result.complete = true;
      break;
    }
  }
  await writeCguNoticeCursor({ version, lastUid, done: result.complete }, now);
  logger.info({ ...result }, "cgu-notice");
  return result;
}
