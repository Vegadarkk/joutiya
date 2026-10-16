import "server-only";
import type { Locale } from "@/config/site";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { serverEnv } from "@/lib/env";

// Who receives a mail about a listing, and in which language: the seller's address (private
// account document), locale and display name. Closed and banned accounts get nothing.

export interface ListingRecipient {
  email: string;
  locale: Locale;
  displayName: string;
}

export async function listingRecipient(uid: string): Promise<ListingRecipient | null> {
  const [user, account] = await Promise.all([getUserRecord(uid), getUserPrivate(uid)]);
  if (!user || !account?.email || user.status === "closed" || user.status === "banned") return null;
  return { email: account.email, locale: user.locale, displayName: user.displayName };
}

/** One lookup per seller within a job run (a seller often has several listings in a batch). */
export function recipientCache(): (uid: string) => Promise<ListingRecipient | null> {
  const cache = new Map<string, Promise<ListingRecipient | null>>();
  return (uid) => {
    let entry = cache.get(uid);
    if (!entry) {
      entry = listingRecipient(uid);
      // A failed lookup is not cached: the next listing of the same seller tries again.
      entry.catch(() => cache.delete(uid));
      cache.set(uid, entry);
    }
    return entry;
  };
}

/** Absolute URL of a page of the public site in the recipient's locale. */
export function siteUrl(locale: Locale, path: string): string {
  return `${serverEnv().SITE_URL.replace(/\/$/, "")}/${locale}/${path.replace(/^\//, "")}`;
}
