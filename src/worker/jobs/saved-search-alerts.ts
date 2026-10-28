import { setTimeout as delay } from "node:timers/promises";
import { ALERT_LISTINGS_PER_SEARCH, digestIdempotencyKey, digestSections, newestSortAt, type SearchNews } from "@/lib/alerts/digest";
import { unsubscribeToken } from "@/lib/alerts/unsubscribe-token";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { deliverMail, type DeliverOutcome } from "@/lib/mail/deliver";
import { ProviderError } from "@/lib/mail/transports/errors";
import type { TemplateMail } from "@/lib/mail/types";
import { listingRecipient, siteUrl } from "@/lib/mail/recipients";
import { isDegraded } from "@/lib/quota";
import { accountEndPath, listDailySearches, markSearchesNotified, readAlertsCursor, writeAlertsCursor, type AlertSearchRecord } from "@/lib/saved-searches/repository";
import { LAG_ALERT_SECONDS, readOutboxLag } from "@/lib/search/indexer";
import { runSearch } from "@/lib/search/service";
import { SearchUnavailableError, type FilterExpr } from "@/lib/search/types";

// Daily at 07:00 UTC (design D19): one digest e-mail per account for its saved searches with an
// alert and new listings. Searches are read from the collection group in document path order, so
// an account's searches arrive together; each search runs one engine query (its parameters +
// lastNotifiedSortAt < sortAt <= horizon, newest first, 5 hits + total; exact matches only, no
// approximate retry). Horizon: the run time minus the indexing delay (5 min, or the outbox lag
// when longer): a matching listing indexed after the run with an older sortAt than one already
// sent would fall behind the moved cursor for good; listings past the horizon wait for the next run.
// Budget: 40 e-mails per run (SAVED_SEARCH_ALERTS_MAX_MAILS) out of the site's ~72 non-security
// mails a day, so transactional mails keep the rest; nothing starts while a Resend quota (day or
// month) is degraded. The digest is delivered here (deliverMail, the mail worker's own call), not
// queued: the search cursors move only once Resend accepted it, so a digest the quotas skip or a
// failing provider holds back loses nothing.
// Rotation: the cursor (system/savedSearchAlerts) holds the last account served; the next run
// starts after it and wraps around, so a capped run never starves the end of the list. An account
// left out keeps its search cursors: its listings come in a later digest, none is lost.

export const SAVED_SEARCH_ALERTS_MAX_MAILS = 40;
export const ALERTS_PAGE_SIZE = 200;
/** Collection-group reads per run at most (pages x size). */
export const ALERTS_MAX_PAGES = 20;
/** Normal indexing delay (D10: a longer outbox lag raises the P1 alert). */
export const ALERT_INDEXING_MARGIN_MS = LAG_ALERT_SECONDS * 1000;
/** Outbox lag counted at most: a stuck entry delays the alerts by this much, it never stops them. */
export const ALERT_MAX_LAG_MS = 6 * 3_600_000;
/** No run while one is degraded (from 90 % of a Resend quota, deliverMail skips every digest). */
const STOP_QUOTAS = ["resend.daily", "resend.monthly", "firestore.reads"] as const;

export interface AlertsResult {
  /** Accounts whose searches were all checked. */
  accounts: number;
  searches: number;
  mails: number;
  /** Accounts with news but no address (closed, banned, missing) or a suppressed or rejected one. */
  skipped: number;
  failed: number;
  /** Every daily search was checked (the next run starts from the first account). */
  complete: boolean;
  stopped?: "quota" | "cap" | "engine" | "mail" | "pages";
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

/** One outbox poll interval (jobs/search.ts OUTBOX_POLL_EVERY_MS): how stale the stored lag can be. */
const OUTBOX_POLL_MARGIN_MS = 60_000;

/**
 * Newest sortAt a run sends (epoch ms): before the indexing delay, the outbox lag when longer.
 * Known limit: a pending entry rewritten by a later edit restarts its enqueuedAt, so a listing
 * edited within its own indexing delay can still land behind the cursor (rare, seconds-wide).
 */
async function alertHorizon(now: Date): Promise<number> {
  const lagMs = Math.min(((await readOutboxLag()) ?? 0) * 1000, ALERT_MAX_LAG_MS);
  return now.getTime() - Math.max(ALERT_INDEXING_MARGIN_MS, lagMs > 0 ? lagMs + OUTBOX_POLL_MARGIN_MS : 0);
}

/** New listings of one search up to `horizon`, or null (none, or only approximate matches). */
async function newsOf(search: AlertSearchRecord, now: Date, horizon: number): Promise<SearchNews | null> {
  if (horizon <= search.lastNotifiedSortAt) return null;
  const extraFilter: FilterExpr = {
    and: [
      { field: "sortAt", op: "gt", value: search.lastNotifiedSortAt },
      { field: "sortAt", op: "lte", value: horizon },
    ],
  };
  const response = await runSearch({ ...search.params, sort: "recent" }, { extraFilter, hitsPerPage: ALERT_LISTINGS_PER_SEARCH, featured: false, facets: false, approximate: false, now });
  if (response.approximate || response.total === 0 || response.hits.length === 0) return null;
  return { searchId: search.id, name: search.name, params: search.params, createdAt: search.createdAt, total: response.total, hits: response.hits };
}

type AccountOutcome = "none" | "sent" | "skipped" | "failed" | "cap" | "quota" | "mail";

/** Attempts for a transient provider failure (429, 5xx, network): the mail queue's quick retries. */
export const ALERT_MAIL_ATTEMPTS = 3;
const ALERT_MAIL_BACKOFF_MS = 2_000;
const ALERT_MAIL_MAX_WAIT_MS = 30_000;

/** deliverMail with quick retries on transient failures (same idempotency key: never sent twice). */
async function deliverWithRetries(mail: TemplateMail): Promise<DeliverOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deliverMail(mail);
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || attempt >= ALERT_MAIL_ATTEMPTS) throw error;
      const waitMs = error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : ALERT_MAIL_BACKOFF_MS * 4 ** (attempt - 1);
      await delay(Math.min(waitMs, ALERT_MAIL_MAX_WAIT_MS));
    }
  }
}

async function serveAccount(group: AlertSearchRecord[], now: Date, horizon: number, result: AlertsResult): Promise<AccountOutcome> {
  const uid = group[0]?.uid;
  if (!uid) return "none";
  const news: SearchNews[] = [];
  for (const search of group) {
    result.searches += 1;
    try {
      const item = await newsOf(search, now, horizon);
      if (item) news.push(item);
    } catch (error) {
      // The engine is down for everyone: stop here, this account is served next time.
      if (error instanceof SearchUnavailableError) throw error;
      logger.warn({ searchId: search.id, err: (error as Error).message }, "saved search alert query failed");
    }
  }
  if (news.length === 0) return "none";
  if (result.mails >= SAVED_SEARCH_ALERTS_MAX_MAILS) return "cap";
  const to = await listingRecipient(uid);
  if (!to) return "skipped";
  let delivered: DeliverOutcome;
  try {
    delivered = await deliverWithRetries({
      template: "savedSearchAlert",
      locale: to.locale,
      to: to.email,
      data: { displayName: to.displayName, searches: digestSections(news, to.locale, siteUrl), unsubscribeToken: unsubscribeToken(uid) },
      priority: "bulk",
      idempotencyKey: digestIdempotencyKey(uid, now),
    });
  } catch (error) {
    // Provider still failing after the quick retries, or unavailable: served by the next run.
    logger.warn({ err: (error as Error).message }, "saved search alert not delivered");
    return "mail";
  }
  if ("skipped" in delivered) {
    // A Resend quota reached its degraded mode (day or month) since the start: stop here.
    if (delivered.skipped === "quota") return "quota";
    logger.info({ reason: delivered.skipped }, "saved search alert skipped");
    return "skipped";
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
  for (const id of STOP_QUOTAS) {
    if (!(await isDegraded(id))) continue;
    logger.info({ quota: id }, "saved-search-alerts skipped: quota degraded");
    return { ...result, stopped: "quota" };
  }
  const horizon = await alertHorizon(now);
  const stored = await readAlertsCursor();
  const scan: Scan = { pages: 0, complete: false };
  let lastServed: string | null = null;
  try {
    for await (const group of accountGroups(stored, scan)) {
      const outcome = await serveAccount(group, now, horizon, result);
      if (outcome === "cap" || outcome === "quota" || outcome === "mail") {
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
