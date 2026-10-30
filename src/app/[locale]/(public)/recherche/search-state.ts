import "server-only";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { makeFilterLabels, type LooseTranslator } from "@/components/search/filter-labels";
import { searchTitle } from "@/components/search/filter-model";
import { CANONICAL_ORIGIN, type Locale } from "@/config/site";
import { examplesHiddenIn } from "@/lib/examples/script";
import { HttpError } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { enforceSearchLimit } from "@/lib/search/limits";
import { SEARCH_PATH, type SearchParams } from "@/lib/search/params";
import { NOT_EXAMPLE, runSearch } from "@/lib/search/service";
import { SearchUnavailableError, type SearchResponse } from "@/lib/search/types";

// Server side of the /recherche page (design D2, D13): the same limits as /api/search, then one
// search. Every failure becomes a page state; nothing here throws to the error boundary.

export type SearchOutcome =
  | { kind: "results"; response: SearchResponse }
  /** Over the limits without a pass: Turnstile in place of the results. */
  | { kind: "challenge" }
  /** Over the limits with a pass. */
  | { kind: "rate_limited"; retryAfter?: number }
  /** Engine down or not configured (D2: honest failure). */
  | { kind: "unavailable" };

/** The page request as a fetch Request (the limit helpers read its headers and cookies). */
export async function pageRequest(): Promise<Request> {
  return new Request(new URL(SEARCH_PATH, CANONICAL_ORIGIN), { headers: new Headers(await headers()) });
}

function retryAfterOf(error: HttpError): number | undefined {
  const seconds = Number(error.headers?.["Retry-After"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export async function loadSearch(params: SearchParams, request: Request): Promise<SearchOutcome> {
  try {
    await enforceSearchLimit(request);
  } catch (error) {
    if (error instanceof HttpError && (error.code === "turnstile_required" || error.code === "turnstile_failed")) return { kind: "challenge" };
    if (error instanceof HttpError && error.code === "rate_limited") return { kind: "rate_limited", retryAfter: retryAfterOf(error) };
    logger.error({ err: (error as Error).message }, "search page: limit check failed");
    return { kind: "unavailable" };
  }
  try {
    // « Masquer les annonces exemples » (cookie of this device): left out here, so counts and pages stay right.
    const hideExamples = examplesHiddenIn(request.headers.get("cookie"));
    return { kind: "results", response: await (hideExamples ? runSearch(params, { extraFilter: NOT_EXAMPLE }) : runSearch(params)) };
  } catch (error) {
    if (error instanceof SearchUnavailableError) logger.warn({ err: error.message }, "search page: engine unavailable");
    else logger.error({ err: (error as Error).message }, "search page: search failed");
    return { kind: "unavailable" };
  }
}

/** Heading of a search for metadata and the H1 (server translators). */
export async function searchPageTitle(locale: Locale, params: SearchParams): Promise<string> {
  const [title, chips, categories, criteria, units] = await Promise.all([
    getTranslations({ locale, namespace: "SearchPage.title" }),
    getTranslations({ locale, namespace: "SearchFilters.chips" }),
    getTranslations({ locale, namespace: "Categories" }),
    getTranslations({ locale, namespace: "Criteria" }),
    getTranslations({ locale, namespace: "Listing.units" }),
  ]);
  const loose = (t: unknown) => t as LooseTranslator;
  const labels = makeFilterLabels({ chips: loose(chips), categories: loose(categories), criteria: loose(criteria), units: loose(units) }, locale);
  return searchTitle(params, locale, labels, (key, values) => title(key, values));
}
