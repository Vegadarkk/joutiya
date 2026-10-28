import { cguAccepted, LEGAL_VERSIONS } from "@/config/legal-versions";
import { listUserRecordsAfter } from "@/lib/db/repositories/profiles";
import { getUserPrivate, readCguNoticeCursor, writeCguNoticeCursor } from "@/lib/db/repositories/users";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { isDegraded } from "@/lib/quota";

// Daily at 09:40 UTC (phase 6, D11; DSA art. 14 § 2): the cguChanged notice, at the lowest priority
// (bulk), to members who accepted an earlier CGU version. The banner under the header tells
// signed-in members at once; this mail reaches the others. The accounts are visited once per CGU
// version in document id order: the cursor (system/cguNotice) holds the version and the last
// account visited, so a run capped by the mail budget resumes where it stopped and a finished
// version costs one read a day. Budget: CGU_NOTICE_MAX_MAILS a run, after the saved-search
// digests (07:00) took theirs; nothing is sent while a Resend quota is degraded.

export const CGU_NOTICE_MAX_MAILS = 20;
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
  stopped?: "quota" | "cap" | "pages";
}

async function quotaStop(): Promise<boolean> {
  return (await Promise.all(STOP_QUOTAS.map((id) => isDegraded(id)))).some(Boolean);
}

export async function sendCguNotices(now = new Date()): Promise<CguNoticeResult> {
  const { version, effective } = LEGAL_VERSIONS.cgu;
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

  for (let pages = 0; ; pages += 1) {
    if (pages >= CGU_NOTICE_MAX_PAGES) {
      result.stopped = "pages";
      break;
    }
    const page = await listUserRecordsAfter(lastUid, CGU_NOTICE_PAGE_SIZE);
    let stoppedInPage = false;
    for (const user of page.users) {
      if (result.mails >= CGU_NOTICE_MAX_MAILS) {
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
            await sendMail({
              template: "cguChanged",
              locale: user.locale,
              to: account.email,
              data: { displayName: user.displayName, version, effective },
              priority: "bulk",
              idempotencyKey: `cguChanged-${version}-${user.uid}`,
            });
            result.mails += 1;
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
