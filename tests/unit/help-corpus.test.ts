import { describe, expect, it } from "vitest";
import { DEFAULT_LEGAL } from "@/config/legal";
import { LOCALES } from "@/config/site";
import { articleBody, HELP_META, HELP_SLUGS, helpArticles, helpValues, validateHelpCorpus, type HelpLocaleContent } from "@/content/help";
import { HELP_AR } from "@/content/help/ar";
import { HELP_FR } from "@/content/help/fr";
import { HELP_RIF } from "@/content/help/rif";
import { MAX_PHOTOS_INDIVIDUAL } from "@/lib/contracts/media";
import { foldHelpText, matchHelp, queryTokens } from "@/lib/help/match";
import { helpDocuments } from "@/lib/help/search";

// Help centre corpus (design phase-5 D25): every article in every locale, placeholders resolved
// from the code's own limits, links to pages that exist, nothing a help text must not hold.

const values = helpValues(DEFAULT_LEGAL);
const CONTENT = { fr: HELP_FR, ar: HELP_AR, rif: HELP_RIF };

describe("help corpus", () => {
  it("validates: every slug in fr, ar and rif, no unknown placeholder, links to existing pages", () => {
    expect(validateHelpCorpus()).toEqual([]);
    for (const locale of LOCALES) expect(Object.keys(CONTENT[locale].articles).sort()).toEqual([...HELP_SLUGS].sort());
    expect(Object.keys(HELP_META).sort()).toEqual([...HELP_SLUGS].sort());
    expect(HELP_SLUGS.length).toBeGreaterThanOrEqual(12);
    for (const slug of HELP_SLUGS) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("reports a missing article, an unknown placeholder and an extra slug", () => {
    const { "signaler-un-contenu": _dropped, ...rest } = HELP_AR.articles;
    const broken: HelpLocaleContent = { categories: HELP_AR.categories, articles: { ...rest, "faq-inconnue": { title: "x", summary: "y", blocks: ["{nope}"] } } as unknown as HelpLocaleContent["articles"] };
    const problems = validateHelpCorpus({ fr: HELP_FR, ar: broken, rif: HELP_RIF });
    expect(problems).toContain("ar: missing article signaler-un-contenu");
    expect(problems).toContain("ar: unknown article faq-inconnue");
    const placeholder: HelpLocaleContent = { ...HELP_FR, articles: { ...HELP_FR.articles, "role-d-aalan": { title: "T", summary: "S {inconnu}", blocks: ["B"] } } };
    expect(validateHelpCorpus({ fr: placeholder, ar: HELP_AR, rif: HELP_RIF })).toEqual(["fr/role-d-aalan: unknown placeholder {inconnu}"]);
  });

  it("fills placeholders from the code's limits and config/legal", () => {
    for (const locale of LOCALES) {
      for (const article of helpArticles(locale, values)) {
        const text = `${article.title} ${article.summary} ${articleBody(article)}`;
        expect(text, `${locale}/${article.slug}`).not.toMatch(/\{\w+\}/);
      }
    }
    const photos = helpArticles("fr", values).find((article) => article.slug === "photos-d-une-annonce");
    expect(photos?.summary).toContain(`${MAX_PHOTOS_INDIVIDUAL} photos`);
    const deposit = helpArticles("fr", helpValues({ ...DEFAULT_LEGAL, listingTtlDays: 45 })).find((article) => article.slug === "deposer-une-annonce");
    expect(deposit?.summary).toContain("45 jours");
  });

  it("holds no address, e-mail or phone number, and promises no phone or WhatsApp contact", () => {
    for (const locale of LOCALES) {
      for (const article of helpArticles(locale, values)) {
        const text = `${article.title}\n${article.summary}\n${articleBody(article)}`;
        expect(text, `${locale}/${article.slug}`).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
        expect(text, `${locale}/${article.slug}`).not.toMatch(/\b(?:rue|avenue|boulevard|bd)\b/i);
        expect(text, `${locale}/${article.slug}`).not.toMatch(/(?:\+212|\b0[5-7])\d{8}/);
        expect(text, `${locale}/${article.slug}`).not.toMatch(/Armaill/i);
      }
    }
    const contact = helpArticles("fr", values).find((article) => article.slug === "contacter-un-vendeur");
    expect(articleBody(contact!)).toContain("n'est pas affiché");
  });

  it("builds one index document per locale and article", () => {
    const documents = helpDocuments(values);
    expect(documents).toHaveLength(LOCALES.length * HELP_SLUGS.length);
    expect(new Set(documents.map((document) => document.id)).size).toBe(documents.length);
    for (const document of documents) expect(document.id).toMatch(/^[A-Za-z0-9_-]{1,400}$/);
    expect(documents.find((document) => document.id === "ar_eviter-les-arnaques")).toMatchObject({ locale: "ar", slug: "eviter-les-arnaques", title: "تجنب الاحتيال" });
  });
});

describe("help search (in process)", () => {
  const entries = (locale: (typeof LOCALES)[number]) => helpArticles(locale, values).map((article) => ({ ...article, body: articleBody(article) }));

  it("folds accents, Arabic variants and digits", () => {
    expect(foldHelpText("Élève À ÉTÉ")).toBe("eleve a ete");
    expect(foldHelpText("الإعلانات ٣")).toBe("الاعلانات 3");
    expect(queryTokens("Comment je peux renouveler mon annonce ?")).toEqual(["renouveler", "annonce"]);
    expect(queryTokens("والإعلانات إعلاني")).toEqual(["اعلان"]);
  });

  it("ranks the article that answers the question first", () => {
    expect(matchHelp(entries("fr"), "renouveler mon annonce")[0]?.slug).toBe("gerer-mes-annonces");
    expect(matchHelp(entries("fr"), "le vendeur demande un acompte par virement")[0]?.slug).toBe("eviter-les-arnaques");
    expect(matchHelp(entries("fr"), "mot de passe oublié")[0]?.slug).toBe("connexion-et-mot-de-passe");
    expect(matchHelp(entries("ar"), "كيف أتجنب الاحتيال")[0]?.slug).toBe("eviter-les-arnaques");
    expect(matchHelp(entries("ar"), "الطعن في قرار")[0]?.slug).toBe("decisions-et-recours");
    expect(matchHelp(entries("rif"), "tawlaft")[0]?.slug).toBe("photos-d-une-annonce");
  });

  it("answers nothing for an empty or stop-word query, and honours the limit", () => {
    expect(matchHelp(entries("fr"), "  ")).toEqual([]);
    expect(matchHelp(entries("fr"), "le la de")).toEqual([]);
    expect(matchHelp(entries("fr"), "annonce", 2)).toHaveLength(2);
  });
});
