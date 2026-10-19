import "server-only";
import { articleBody, helpArticles, helpValues, type HelpArticle, type HelpValues } from "@/content/help";
import { LOCALES, type Locale } from "@/config/site";
import type { HelpHit } from "@/lib/contracts/assistant";
import { serverEnv } from "@/lib/env";
import { getLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";
import { MeiliEngine } from "@/lib/search/meili";
import { z } from "@/lib/zod";
import { matchHelp } from "./match";

// The `help` index (design phase-5 D25, AF §5): the help articles of the three locales, one
// document per locale and slug. The worker replaces it at start (src/worker/index.ts), and
// scripts/search-setup.ts --apply on an environment's first setup. The assistant searches it for
// the articles to show; without Meilisearch (development) or when it fails, the same corpus is
// searched in process (src/lib/help/match.ts), so the help centre never depends on the engine.

export const HELP_INDEX = "help";

export const HELP_INDEX_SETTINGS = {
  searchableAttributes: ["title", "keywords", "summary", "body"],
  filterableAttributes: ["locale"],
  displayedAttributes: ["slug", "title", "summary"],
} as const;

export interface HelpIndexDocument {
  id: string;
  locale: Locale;
  slug: string;
  category: string;
  title: string;
  summary: string;
  keywords: string[];
  body: string;
}

export function helpDocuments(values: HelpValues): HelpIndexDocument[] {
  return LOCALES.flatMap((locale) =>
    helpArticles(locale, values).map((article) => ({
      id: `${locale}_${article.slug}`,
      locale,
      slug: article.slug,
      category: article.category,
      title: article.title,
      summary: article.summary,
      keywords: article.keywords,
      body: articleBody(article),
    })),
  );
}

/** The locale's articles with config/legal's values (5-minute cache). */
export async function loadHelpArticles(locale: Locale): Promise<HelpArticle[]> {
  return helpArticles(locale, helpValues(await getLegalConfig()));
}

function helpEngine(): MeiliEngine | null {
  const env = serverEnv();
  if (!env.MEILI_URL) return null;
  return new MeiliEngine({ url: env.MEILI_URL, searchKey: env.MEILI_SEARCH_KEY, indexKey: env.MEILI_INDEX_KEY, index: HELP_INDEX, readTimeoutMs: 1500 });
}

const hitsSchema = z.object({ hits: z.array(z.object({ slug: z.string(), title: z.string(), summary: z.string() }).passthrough()) }).passthrough();

const toHit = (article: Pick<HelpArticle, "slug" | "title" | "summary">): HelpHit => ({ slug: article.slug, title: article.title, summary: article.summary });

/** In process over `articles`. */
export function matchArticles(articles: readonly HelpArticle[], query: string, limit: number): HelpHit[] {
  return matchHelp(
    articles.map((article) => ({ ...article, body: articleBody(article) })),
    query,
    limit,
  ).map(toHit);
}

/** The articles that best match `query` in `locale`: Meilisearch, else the in-process search. */
export async function searchHelp(locale: Locale, query: string, limit = 4, articles?: readonly HelpArticle[]): Promise<HelpHit[]> {
  const corpus = articles ?? (await loadHelpArticles(locale));
  const known = new Map(corpus.map((article) => [article.slug, article]));
  const engine = helpEngine();
  if (engine) {
    try {
      const raw = await engine.searchRaw({ q: query.slice(0, 200), filter: `locale = "${locale}"`, limit, attributesToRetrieve: ["slug", "title", "summary"] });
      const parsed = hitsSchema.parse(raw);
      // The live corpus wins over a stale index (the worker replaces it at start).
      return parsed.hits.flatMap((hit) => {
        const article = known.get(hit.slug as HelpArticle["slug"]);
        return article ? [toHit(article)] : [];
      });
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "help index unavailable: in-process help search");
    }
  }
  return matchArticles(corpus, query, limit);
}

/** Replaces the `help` index with the current corpus; false when Meilisearch is not configured. */
export async function syncHelpIndex(engine: MeiliEngine | null = helpEngine()): Promise<boolean> {
  if (!engine) return false;
  await engine.replaceAll({ ...HELP_INDEX_SETTINGS }, helpDocuments(helpValues(await getLegalConfig())));
  return true;
}
