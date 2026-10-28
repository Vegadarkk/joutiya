import { LOCALES, SITE_NAME, type Locale } from "@/config/site";
import { GUIDE_AR } from "./ar";
import { GUIDE_GENERAL_SOURCES, GUIDE_PROCEDURE_IDS, GUIDE_PROCEDURES, GUIDE_RUBRICS, rubricProcedures, type GuideLocaleContent, type GuideProcedureId, type GuideRubric } from "./catalog";
import { GUIDE_FR } from "./fr";
import { GUIDE_RIF } from "./rif";
import { GUIDE_SOURCE_IDS, GUIDE_SOURCES, isOfficialHost, type GuideSourceId } from "./sources";

// Admin procedures guide loader (design guide-demarches G1-G2): the locale's texts with `{brand}`
// filled, and the validator the unit tests run (closed host list, no URL in a text, no stray id).

export * from "./catalog";
export * from "./sources";

const CONTENT: Readonly<Record<Locale, GuideLocaleContent>> = { fr: GUIDE_FR, ar: GUIDE_AR, rif: GUIDE_RIF };

const fill = (text: string) => text.replaceAll("{brand}", SITE_NAME);

export interface GuideProcedure {
  id: GuideProcedureId;
  title: string;
  body: string[];
  prepare: string[];
  sources: readonly GuideSourceId[];
}

export interface GuideRubricPage {
  rubric: GuideRubric;
  title: string;
  summary: string;
  intro: string;
  procedures: GuideProcedure[];
  /** Latest human review among the rubric's sources (YYYY-MM-DD). */
  reviewedAt: string;
}

export function guideRubricCard(locale: Locale, rubric: GuideRubric): { rubric: GuideRubric; title: string; summary: string } {
  const text = CONTENT[locale].rubrics[rubric];
  return { rubric, title: fill(text.title), summary: fill(text.summary) };
}

export function guideRubricPage(locale: Locale, rubric: GuideRubric): GuideRubricPage {
  const content = CONTENT[locale];
  const procedures = rubricProcedures(rubric).map((id): GuideProcedure => {
    const text = content.procedures[id];
    return { id, title: fill(text.title), body: text.body.map(fill), prepare: (text.prepare ?? []).map(fill), sources: GUIDE_PROCEDURES[id].sources };
  });
  const reviewed = procedures.flatMap((procedure) => procedure.sources.map((id) => GUIDE_SOURCES[id].reviewedAt)).sort();
  return { ...guideRubricCard(locale, rubric), intro: fill(content.rubrics[rubric].intro), procedures, reviewedAt: reviewed.at(-1) ?? "" };
}

export function guideSourceLabel(locale: Locale, id: GuideSourceId): string {
  return fill(CONTENT[locale].sources[id]);
}

// ---- Validation (tests/unit/guide-corpus.test.ts).

const TITLE_MAX = 80;
const SUMMARY_MAX = 160;
const URL_IN_TEXT = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:ma|com|org|net|fr)\b/i;
const FILE_URL = /\.(?:pdf|docx?|xlsx?|odt|zip)(?:$|[?#])/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function textsOf(content: GuideLocaleContent): { where: string; text: string }[] {
  const texts: { where: string; text: string }[] = [];
  for (const [rubric, text] of Object.entries(content.rubrics)) for (const value of [text.title, text.summary, text.intro]) texts.push({ where: `rubric ${rubric}`, text: value });
  for (const [id, text] of Object.entries(content.procedures)) for (const value of [text.title, ...text.body, ...(text.prepare ?? [])]) texts.push({ where: `procedure ${id}`, text: value });
  return texts;
}

/** Problems of the guide, empty when every link is official and every locale is complete. */
export function validateGuide(contents: Readonly<Record<Locale, GuideLocaleContent>> = CONTENT, sources: Readonly<Record<string, { url: string; reviewedAt: string }>> = GUIDE_SOURCES): string[] {
  const problems: string[] = [];
  for (const [id, source] of Object.entries(sources)) {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      problems.push(`source ${id}: invalid URL`);
      continue;
    }
    if (url.protocol !== "https:") problems.push(`source ${id}: not https`);
    if (!isOfficialHost(url.hostname)) problems.push(`source ${id}: host ${url.hostname} is not in OFFICIAL_HOSTS`);
    if (!/\.(?:gov\.)?ma$/.test(url.hostname)) problems.push(`source ${id}: host ${url.hostname} is not a .ma host`);
    if (url.username || url.password || url.port) problems.push(`source ${id}: credentials or port in the URL`);
    if (FILE_URL.test(url.pathname)) problems.push(`source ${id}: links a file, link the official page that lists it`);
    if (!DAY.test(source.reviewedAt)) problems.push(`source ${id}: reviewedAt is not YYYY-MM-DD`);
  }
  const urls = Object.values(sources).map((source) => source.url);
  if (new Set(urls).size !== urls.length) problems.push("two sources share a URL");
  const used = new Set<string>([...GUIDE_GENERAL_SOURCES, ...GUIDE_PROCEDURE_IDS.flatMap((id) => GUIDE_PROCEDURES[id].sources)]);
  for (const id of Object.keys(sources)) if (!used.has(id)) problems.push(`source ${id}: unused`);
  for (const id of used) if (!Object.hasOwn(sources, id)) problems.push(`unknown source ${id}`);
  for (const rubric of GUIDE_RUBRICS) if (rubricProcedures(rubric).length === 0) problems.push(`rubric ${rubric}: no procedure`);
  for (const id of GUIDE_PROCEDURE_IDS) if ((GUIDE_PROCEDURES[id].sources as readonly string[]).length === 0) problems.push(`procedure ${id}: no source`);

  for (const locale of LOCALES) {
    const content = contents[locale];
    for (const rubric of GUIDE_RUBRICS) {
      const text = content.rubrics[rubric];
      if (!text) {
        problems.push(`${locale}: missing rubric ${rubric}`);
        continue;
      }
      if (!text.title.trim() || text.title.length > TITLE_MAX) problems.push(`${locale}/${rubric}: title empty or over ${TITLE_MAX}`);
      if (!text.summary.trim() || text.summary.length > SUMMARY_MAX) problems.push(`${locale}/${rubric}: summary empty or over ${SUMMARY_MAX}`);
      if (!text.intro.trim()) problems.push(`${locale}/${rubric}: no intro`);
    }
    for (const id of GUIDE_PROCEDURE_IDS) {
      const text = content.procedures[id];
      if (!text) problems.push(`${locale}: missing procedure ${id}`);
      else if (!text.title.trim() || text.title.length > TITLE_MAX || text.body.length === 0) problems.push(`${locale}/${id}: title or body invalid`);
    }
    for (const id of Object.keys(content.procedures)) if (!Object.hasOwn(GUIDE_PROCEDURES, id)) problems.push(`${locale}: unknown procedure ${id}`);
    for (const id of GUIDE_SOURCE_IDS) if (!content.sources[id]?.trim()) problems.push(`${locale}: missing label of source ${id}`);
    for (const { where, text } of textsOf(content)) {
      if (!text.trim()) problems.push(`${locale}/${where}: empty text`);
      if (URL_IN_TEXT.test(text)) problems.push(`${locale}/${where}: a text holds an address; link a source instead`);
      for (const [match] of text.matchAll(/\{(\w+)\}/g)) if (match !== "{brand}") problems.push(`${locale}/${where}: unknown placeholder ${match}`);
    }
  }
  return problems;
}
