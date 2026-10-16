import type { Locale } from "@/config/site";
import type { SavedSearchAlertSection } from "@/lib/mail/types";
import { searchPath, type SearchParams } from "@/lib/search/params";
import type { SearchCard } from "@/lib/search/types";

// Pure parts of the saved-search alerts (design D19): what one search contributes to a digest,
// the digest sections and the daily idempotency key. The job (src/worker/jobs/saved-search-alerts.ts)
// does the reads, the engine queries and the writes.

/** Listings shown per search in the e-mail (the total links to the rest). */
export const ALERT_LISTINGS_PER_SEARCH = 5;

/** New listings of one saved search since its cursor. */
export interface SearchNews {
  searchId: string;
  name: string;
  params: SearchParams;
  createdAt: Date;
  total: number;
  /** Newest first, ALERT_LISTINGS_PER_SEARCH at most. */
  hits: SearchCard[];
}

/** sortAt (epoch ms) of the newest listing sent: the search's next cursor. */
export function newestSortAt(hits: readonly SearchCard[]): number {
  return hits.reduce((newest, hit) => Math.max(newest, Date.parse(hit.sortAt) || 0), 0);
}

/** UTC day of a run, "20261016". */
export function digestDay(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

/** One digest per account per day (queue jobId and Resend Idempotency-Key). */
export function digestIdempotencyKey(uid: string, now: Date): string {
  return `savedSearchAlert-${uid}-${digestDay(now)}`;
}

/**
 * Sections of the digest, newest saved search first (the order of the account page). `url` builds
 * an absolute URL of the site in the recipient's locale.
 */
export function digestSections(news: readonly SearchNews[], locale: Locale, url: (locale: Locale, path: string) => string): SavedSearchAlertSection[] {
  return [...news]
    .filter((item) => item.total > 0 && item.hits.length > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((item) => ({
      name: item.name,
      // Newest first on the results page too: the e-mail is about what is new.
      url: url(locale, searchPath({ ...item.params, sort: "recent", page: undefined })),
      total: item.total,
      listings: item.hits.slice(0, ALERT_LISTINGS_PER_SEARCH).map((hit) => ({
        title: hit.title,
        url: url(locale, `annonce/${hit.slugId}`),
        price: hit.price,
        isDonation: hit.isDonation,
        citySlug: hit.citySlug,
      })),
    }));
}
