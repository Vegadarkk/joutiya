import { ALERT_LISTINGS_PER_SEARCH, digestIdempotencyKey, digestSections, newestSortAt, type SearchNews } from "@/lib/alerts/digest";
import { unsubscribeToken } from "@/lib/alerts/unsubscribe-token";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { listingRecipient, siteUrl } from "@/lib/mail/recipients";
import { isDegraded } from "@/lib/quota";
import { accountEndPath, listDailySearches, markSearchesNotified, readAlertsCursor, writeAlertsCursor, type AlertSearchRecord } from "@/lib/saved-searches/repository";
import { runSearch } from "@/lib/search/service";
import { SearchUnavailableError } from "@/lib/search/types";

// Daily at 07:00 UTC (design D19): one digest e-mail per account for its saved searches with an
// alert and new listings. Searches are read from the collection group in document path order, so
// an account's searches arrive together; each search runs one engine query (its parameters +
// sortAt > lastNotifiedSortAt, newest first, 5 hits + total; exact matches only, no approximate retry).
// Budget: 40 e-mails per run (SAVED_SEARCH_ALERTS_MAX_MAILS) out of Resend's ~90 non-security
// mails a day, so transactional mails keep the rest; nothing starts while resend.daily is degraded.
// Rotation: the cursor (system/savedSearchAlerts) holds the last account served; the next run
// starts after it and wraps around, so a capped run never starves the end of the list. An account
// left out keeps its search cursors: its listings come in a later digest, none is lost.

export const SAVED_SEARCH_ALERTS_MAX_MAILS = 40;
export const ALERTS_PAGE_SIZE = 200;
/** Collection-group reads per run at most (pages x size). */
export const ALERTS_MAX_PAGES = 20;

export interface AlertsResult {
  /** Accounts whose searches were all checked. */
  accounts: number;
  searches: number;
  mails: number;
  /** Accounts with news but no address (closed, banned, missing). */
  skipped: number;
  failed: number;
  /** Every daily search was checked (the next run starts from the first account). */
  complete: boolean;
  stopped?: "quota" | "cap" | "engine" | "queue" | "pages";
}

interface Scan {
  pages: number;
  complete: boolean;
}

/**
 * Complete account groups in path order: after `afterUid` to the end, then from the first account
 * up to `afterUid` (wrap). An account cut by the page budget is not yielded.
 */
async function* accountGroups(afterUid: string | null, scan: Scan): AsyncGenerator<AlertSearchRecord[]> {
  const segments: { afterPath?: string; endAtPath?: string }[] = afterUid ? [{ afterPath: accountEndPath(afterUid) }, { endAtPath: accountEndPath(afterUid) }] : [{}];
  for (const segment of segments) {
    let afterPath = segment.afterPath;
    let group: AlertSearchRecord[] = [];
    for (;;) {
      if (scan.pages >= ALERTS_MAX_PAGES) return;
      const page = await listDailySearches({ afterPath, endAtPath: segment.endAtPath, limit: ALERTS_PAGE_SIZE });
      scan.pages += 1;
      for (const search of page.searches) {
        if (group.length > 0 && group[0]?.uid !== search.uid) {
          yield group;
          group = [];
        }
        group.push(search);
      }
      if (page.read < ALERTS_PAGE_SIZE || !page.lastPath) break;
      afterPath = page.lastPath;
    }
    if (group.length > 0) yield group;
  }
  scan.complete = true;
}

/** New listings of one search, or null (none, or only approximate matches). */
async function newsOf(search: AlertSearchRecord, now: Date): Promise<SearchNews | null> {
  const response = await runSearch(
    { ...search.params, sort: "recent" },
    { extraFilter: { field: "sortAt", op: "gt", value: search.lastNotifiedSortAt }, hitsPerPage: ALERT_LISTINGS_PER_SEARCH, featured: false, facets: false, approximate: false, now },
  );
  if (response.approximate || response.total === 0 || response.hits.length === 0) return null;
  return { searchId: search.id, name: search.name, params: search.params, createdAt: search.createdAt, total: response.total, hits: response.hits };
}

type AccountOutcome = "none" | "sent" | "skipped" | "failed" | "cap" | "quota" | "queue";

async function serveAccount(group: AlertSearchRecord[], now: Date, result: AlertsResult): Promise<AccountOutcome> {
  const uid = group[0]?.uid;
  if (!uid) return "none";
  const news: SearchNews[] = [];
  for (const search of group) {
    result.searches += 1;
    try {
      const item = await newsOf(search, now);
      if (item) news.push(item);
    } catch (error) {
      // The engine is down for everyone: stop here, this account is served next time.
      if (error instanceof SearchUnavailableError) throw error;
      logger.warn({ searchId: search.id, err: (error as Error).message }, "saved search alert query failed");
    }
  }
  if (news.length === 0) return "none";
  if (result.mails >= SAVED_SEARCH_ALERTS_MAX_MAILS) return "cap";
  if (await isDegraded("resend.daily")) return "quota";
  const to = await listingRecipient(uid);
  if (!to) return "skipped";
  try {
    await sendMail({
      template: "savedSearchAlert",
      locale: to.locale,
      to: to.email,
      data: { displayName: to.displayName, searches: digestSections(news, to.locale, siteUrl), unsubscribeToken: unsubscribeToken(uid) },
      priority: "bulk",
      idempotencyKey: digestIdempotencyKey(uid, now),
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "saved search alert enqueue failed");
    return "queue";
  }
  try {
    await markSearchesNotified(
      news.map((item) => ({ uid, id: item.searchId, lastNotifiedSortAt: newestSortAt(item.hits) })),
      now,
    );
  } catch (error) {
    // The mail left: the same listings may come again tomorrow (logged, not fatal).
    logger.error({ err: (error as Error).message }, "saved search alert cursors not updated");
    return "failed";
  }
  return "sent";
}

export async function sendSavedSearchAlerts(now = new Date()): Promise<AlertsResult> {
  const result: AlertsResult = { accounts: 0, searches: 0, mails: 0, skipped: 0, failed: 0, complete: false };
  if (!isFirestoreConfigured()) {
    logger.warn("saved-search-alerts skipped: Firebase not configured");
    return result;
  }
  if ((await isDegraded("resend.daily")) || (await isDegraded("firestore.reads"))) {
    logger.info("saved-search-alerts skipped: quota degraded");
    return { ...result, stopped: "quota" };
  }
  const stored = await readAlertsCursor();
  const scan: Scan = { pages: 0, complete: false };
  let lastServed: string | null = null;
  try {
    for await (const group of accountGroups(stored, scan)) {
      const outcome = await serveAccount(group, now, result);
      if (outcome === "cap" || outcome === "quota" || outcome === "queue") {
        result.stopped = outcome;
        break;
      }
      if (outcome === "sent") result.mails += 1;
      else if (outcome === "skipped") result.skipped += 1;
      else if (outcome === "failed") {
        result.mails += 1;
        result.failed += 1;
      }
      result.accounts += 1;
      lastServed = group[0]?.uid ?? lastServed;
    }
    if (!result.stopped && !scan.complete) result.stopped = "pages";
  } catch (error) {
    if (!(error instanceof SearchUnavailableError)) throw error;
    logger.warn({ err: error.message }, "saved-search-alerts stopped: search engine unavailable");
    result.stopped = "engine";
  } finally {
    result.complete = scan.complete && !result.stopped;
    // Complete: the next run starts from the first account. Otherwise after the last one served
    // (unchanged when none was).
    const next = result.complete ? null : (lastServed ?? stored);
    await writeAlertsCursor(next, { mails: result.mails, accounts: result.accounts, complete: result.complete }, now);
  }
  logger.info({ ...result }, "saved-search-alerts");
  return result;
}
