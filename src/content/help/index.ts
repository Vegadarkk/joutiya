import type { LegalConfig } from "@/config/legal";
import { LEGAL_PAGES } from "@/config/legal-pages";
import { LOCALES, type Locale } from "@/config/site";
import { APPEAL_SLA_DAYS } from "@/lib/contracts/appeals";
import { MESSAGE_TEXT_MAX } from "@/lib/contracts/endpoints";
import { MAX_DRAFTS } from "@/lib/contracts/listings";
import { MAX_PHOTOS_INDIVIDUAL, MAX_UPLOAD_BYTES } from "@/lib/contracts/media";
import { SAVED_SEARCHES_MAX } from "@/lib/contracts/search";
import { DRAFT_PURGE_DAYS, RENEW_WINDOW_DAYS } from "@/lib/listings/lifecycle";
import { HELP_CATEGORIES, HELP_META, HELP_SLUGS, type HelpBlock, type HelpCategory, type HelpLink, type HelpLocaleContent, type HelpSlug } from "./catalog";
import { HELP_AR } from "./ar";
import { HELP_FR } from "./fr";
import { HELP_RIF } from "./rif";

// Help centre loader (design phase-5 D25): the locale's articles with their placeholders filled,
// their plain text (the assistant's corpus, the `help` index, the /aide search) and the validator
// the unit tests run. No server import: pages, the API, the worker and the tests share it.

export * from "./catalog";

const CONTENT: Readonly<Record<Locale, HelpLocaleContent>> = { fr: HELP_FR, ar: HELP_AR, rif: HELP_RIF };

/** Values of the `{name}` placeholders: the code's own limits and config/legal's listing lifetime. */
export type HelpValues = Readonly<Record<string, string>>;

export function helpValues(legal: Pick<LegalConfig, "listingTtlDays">): HelpValues {
  return {
    ttlDays: String(legal.listingTtlDays),
    maxPhotos: String(MAX_PHOTOS_INDIVIDUAL),
    photoMb: String(Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))),
    maxDrafts: String(MAX_DRAFTS),
    draftPurgeDays: String(DRAFT_PURGE_DAYS),
    renewDays: String(RENEW_WINDOW_DAYS),
    savedMax: String(SAVED_SEARCHES_MAX),
    messageMax: String(MESSAGE_TEXT_MAX),
    appealDays: String(APPEAL_SLA_DAYS),
  };
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(text: string, values: HelpValues): string {
  return text.replace(PLACEHOLDER, (match, key: string) => values[key] ?? match);
}

function fillBlock(block: HelpBlock, values: HelpValues): HelpBlock {
  if (typeof block === "string") return fill(block, values);
  if ("list" in block) return { list: block.list.map((item) => fill(item, values)) };
  if ("steps" in block) return { steps: block.steps.map((item) => fill(item, values)) };
  return { note: fill(block.note, values) };
}

export interface HelpArticle {
  slug: HelpSlug;
  category: HelpCategory;
  title: string;
  summary: string;
  blocks: HelpBlock[];
  keywords: string[];
  links: readonly HelpLink[];
}

export function isHelpSlug(value: string): value is HelpSlug {
  return (HELP_SLUGS as readonly string[]).includes(value);
}

export function helpCategories(locale: Locale): HelpLocaleContent["categories"] {
  return CONTENT[locale].categories;
}

export function helpArticle(locale: Locale, slug: HelpSlug, values: HelpValues): HelpArticle {
  const text = CONTENT[locale].articles[slug];
  return {
    slug,
    category: HELP_META[slug].category,
    title: fill(text.title, values),
    summary: fill(text.summary, values),
    blocks: text.blocks.map((block) => fillBlock(block, values)),
    keywords: [...(text.keywords ?? [])],
    links: HELP_META[slug].links,
  };
}

/** Every article of the locale, catalog order (categories in HELP_CATEGORIES order). */
export function helpArticles(locale: Locale, values: HelpValues): HelpArticle[] {
  const rank = (slug: HelpSlug) => HELP_CATEGORIES.indexOf(HELP_META[slug].category);
  return [...HELP_SLUGS].sort((a, b) => rank(a) - rank(b) || HELP_SLUGS.indexOf(a) - HELP_SLUGS.indexOf(b)).map((slug) => helpArticle(locale, slug, values));
}

/** The body as plain text: paragraphs, "- " items, "1. " steps, notes. */
export function articleBody(article: Pick<HelpArticle, "blocks">): string {
  return article.blocks
    .map((block) => {
      if (typeof block === "string") return block;
      if ("list" in block) return block.list.map((item) => `- ${item}`).join("\n");
      if ("steps" in block) return block.steps.map((item, index) => `${index + 1}. ${item}`).join("\n");
      return block.note;
    })
    .join("\n");
}

// ---- Validation (tests/unit/help-corpus.test.ts).

const TITLE_MAX = 80;
const SUMMARY_MAX = 200;
const LEGAL_SLUGS: readonly string[] = LEGAL_PAGES.map((page) => page.slug);

function textsOf(content: HelpLocaleContent, slug: HelpSlug): string[] {
  const article = content.articles[slug];
  if (!article) return [];
  const blocks = article.blocks.flatMap((block) => (typeof block === "string" ? [block] : "list" in block ? block.list : "steps" in block ? block.steps : [block.note]));
  return [article.title, article.summary, ...blocks, ...(article.keywords ?? [])];
}

/** Problems of the corpus, empty when every locale has every article, filled and linked correctly. */
export function validateHelpCorpus(contents: Readonly<Record<Locale, HelpLocaleContent>> = CONTENT): string[] {
  const problems: string[] = [];
  const known = new Set(Object.keys(helpValues({ listingTtlDays: 1 })));
  for (const locale of LOCALES) {
    const content = contents[locale];
    for (const category of HELP_CATEGORIES) {
      if (!content.categories[category]?.title.trim()) problems.push(`${locale}: category ${category} has no title`);
    }
    for (const slug of Object.keys(content.articles)) {
      if (!isHelpSlug(slug)) problems.push(`${locale}: unknown article ${slug}`);
    }
    for (const slug of HELP_SLUGS) {
      const article = content.articles[slug];
      if (!article) {
        problems.push(`${locale}: missing article ${slug}`);
        continue;
      }
      if (!article.title.trim() || article.title.length > TITLE_MAX) problems.push(`${locale}/${slug}: title empty or over ${TITLE_MAX}`);
      if (!article.summary.trim() || article.summary.length > SUMMARY_MAX) problems.push(`${locale}/${slug}: summary empty or over ${SUMMARY_MAX}`);
      if (article.blocks.length === 0) problems.push(`${locale}/${slug}: no body`);
      for (const text of textsOf(content, slug)) {
        if (!text.trim()) problems.push(`${locale}/${slug}: empty text`);
        for (const [, key] of text.matchAll(PLACEHOLDER)) if (key && !known.has(key)) problems.push(`${locale}/${slug}: unknown placeholder {${key}}`);
      }
    }
  }
  for (const slug of HELP_SLUGS) {
    for (const link of HELP_META[slug].links) {
      if (link.kind === "help" && (!isHelpSlug(link.slug) || link.slug === slug)) problems.push(`${slug}: bad help link ${link.slug}`);
      if (link.kind === "legal" && !LEGAL_SLUGS.includes(link.slug)) problems.push(`${slug}: bad legal link ${link.slug}`);
    }
  }
  return problems;
}
