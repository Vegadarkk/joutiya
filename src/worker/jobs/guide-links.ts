import type { Firestore } from "firebase-admin/firestore";
import { GUIDE_SOURCE_IDS, GUIDE_SOURCES, type GuideSourceId } from "@/content/guide/sources";
import { alert } from "@/lib/alert";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { classifyFetch, linkFlags, nextLinkState, type LinkFlag } from "@/lib/guide/check";
import { fetchGuidePage, type FetchedPage } from "@/lib/guide/fetch-page";
import { readGuideState, writeGuideState, type GuideState } from "@/lib/guide/state";
import { logger } from "@/lib/logging/logger";

// Weekly check of the admin procedures guide's links (design guide-demarches G4), Monday 06:10 UTC.
// Every source of the registry is fetched (hosts in parallel, a host's pages one after the other,
// one retry when nothing answered), classified and fingerprinted; system/guide-links keeps the
// result (one read, one write). The back office (/guide) shows the flags; one `info` alert lists the
// sources newly flagged this run, none when nothing changed.

export const HOST_CONCURRENCY = 6;

const FLAG_LABELS: Record<LinkFlag, string> = {
  failing: "lien en échec",
  blocked: "bloqué ou injoignable depuis 4 semaines",
  changed: "page modifiée",
  "review-due": "relecture humaine due",
  unconfirmed: "jamais vu en ligne",
};

export interface GuideLinksResult {
  checked: number;
  ok: number;
  flagged: number;
  newlyFlagged: string[];
}

export interface GuideLinksDeps {
  db?: Firestore;
  fetchPage?: (url: string) => Promise<FetchedPage>;
}

async function fetchWithRetry(fetchPage: (url: string) => Promise<FetchedPage>, url: string): Promise<FetchedPage> {
  const first = await fetchPage(url);
  return first.status === null && !first.offsite ? fetchPage(url) : first;
}

async function inPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  });
  await Promise.all(workers);
}

export async function checkGuideLinks(now = new Date(), deps: GuideLinksDeps = {}): Promise<GuideLinksResult | null> {
  if (!deps.db && !isFirestoreConfigured()) {
    logger.warn("guide-links skipped: Firebase not configured");
    return null;
  }
  const firestore = deps.db ?? db();
  const fetchPage = deps.fetchPage ?? ((url: string) => fetchGuidePage(url));
  const previous = await readGuideState(firestore);
  const next: GuideState = { runAt: now.toISOString(), links: {} };

  const byHost = new Map<string, GuideSourceId[]>();
  for (const id of GUIDE_SOURCE_IDS) {
    const host = new URL(GUIDE_SOURCES[id].url).hostname;
    byHost.set(host, [...(byHost.get(host) ?? []), id]);
  }
  await inPool([...byHost.values()], HOST_CONCURRENCY, async (ids) => {
    for (const id of ids) {
      const { url } = GUIDE_SOURCES[id];
      const page = await fetchWithRetry(fetchPage, url);
      const { outcome, detail } = classifyFetch(url, page);
      const reached = outcome === "ok" || outcome === "redirected";
      next.links[id] = nextLinkState(previous.links[id], url, { outcome, detail, httpStatus: page.status, finalUrl: page.finalUrl, ...(reached && page.fingerprint ? { fingerprint: page.fingerprint } : {}) }, now);
    }
  });

  const newlyFlagged: string[] = [];
  let flagged = 0;
  let ok = 0;
  for (const id of GUIDE_SOURCE_IDS) {
    const source = GUIDE_SOURCES[id];
    const state = next.links[id];
    if (state?.outcome === "ok") ok += 1;
    const flags = linkFlags(source, state, now);
    if (flags.length > 0) flagged += 1;
    // Flags as the last run left them (none before the first run): only the new ones are alerted.
    const before = new Set(previous.runAt ? linkFlags(source, previous.links[id], new Date(previous.runAt)) : []);
    const fresh = flags.filter((flag) => !before.has(flag));
    if (fresh.length > 0) newlyFlagged.push(`${id} (${fresh.map((flag) => FLAG_LABELS[flag]).join(", ")})`);
  }

  await writeGuideState(next, firestore);
  if (newlyFlagged.length > 0) {
    await alert({
      severity: "info",
      title: "Guide des démarches : liens à vérifier",
      body: `${newlyFlagged.length} source(s) à revoir dans le back-office (Guide démarches) :\n${newlyFlagged.slice(0, 20).join("\n")}`,
    });
  }
  const result: GuideLinksResult = { checked: GUIDE_SOURCE_IDS.length, ok, flagged, newlyFlagged };
  logger.info({ ...result }, "guide-links");
  return result;
}
