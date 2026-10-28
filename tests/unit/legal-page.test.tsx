import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { DEFAULT_LEGAL } from "@/config/legal";
import type { LegalSlug } from "@/config/legal-pages";
import { LEGAL_VERSIONS } from "@/config/legal-versions";
import type { Locale } from "@/config/site";
import { LegalPage } from "@/components/legal/legal-page";
import { loadMessages } from "@/i18n/messages";
import { numbersLocale } from "@/i18n/params";
import { parseMarkdown } from "@/lib/legal/markdown";
import { legalSource } from "@/lib/legal/sources";
import { renderTemplate } from "@/lib/legal/template";
import { legalScope } from "@/lib/legal/values";

async function html(locale: Locale, markdown: string, props: { language?: "fr" | "ar"; provisional?: boolean } = {}): Promise<string> {
  const language = props.language ?? (locale === "ar" ? "ar" : "fr");
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={await loadMessages(locale)} timeZone="Africa/Casablanca">
      <LegalPage blocks={parseMarkdown(markdown)} language={language} translated={language === "ar"} frenchOnly={locale !== "fr" && language === "fr"} provisional={props.provisional} />
    </NextIntlClientProvider>,
  );
}

function page(slug: LegalSlug, language: "fr" | "ar"): string {
  return renderTemplate(legalSource(slug, language), legalScope(DEFAULT_LEGAL, { whatsapp: false, ads: false, adsCmpEea: false }, LEGAL_VERSIONS[slug], language)).text;
}

describe("LegalPage", () => {
  it("prints the title, the version line and a table of contents of the sections", async () => {
    const out = await html("fr", page("cgu", "fr"));
    expect(out).toContain("<h1 class=\"text-3xl font-semibold text-balance sm:text-4xl\">Conditions générales d&#x27;utilisation</h1>");
    expect(out).toMatch(/data-testid="legal-version"[^>]*>Version 1\.0 — en vigueur le \d{1,2} \S+ 2026<\/p>/);
    expect(out).toContain('<nav aria-labelledby="legal-toc"');
    expect(out).toMatch(/<a href="#role"[^>]*>/);
    expect(out).toMatch(/<h2 id="role"/);
  });

  it("dates the Arabic text in Arabic and notes that French prevails", async () => {
    const out = await html("ar", page("cgu", "ar"));
    expect(out).toContain('lang="ar" dir="rtl"');
    expect(out).toContain("النص الفرنسي هو المرجع القانوني المعتمد");
    expect(out).not.toContain("Les textes légaux font foi");
  });

  it("shows the French text with a note on the Tarifit site and for pages without an Arabic text", async () => {
    const rif = await html("rif", page("cgu", "fr"));
    expect(rif).toContain('lang="fr" dir="ltr"');
    expect(rif).toContain("Un résumé en tarifit");
    const cgv = await html("ar", page("cgv", "fr"), { language: "fr", provisional: true });
    expect(cgv).toContain("هذا النص متوفر بالفرنسية فقط");
    expect(cgv).toContain("نسخة مؤقتة");
    expect(await html("fr", page("cgu", "fr"))).not.toContain("<aside");
  });

  it("localizes same-site links, keeps external ones and never renders raw HTML", async () => {
    const out = await html("ar", "# T\n\nVersion 1\n\nVoir [CGU](/legal/cgu#role), [CNDP](https://www.cndp.ma) et <script>alert(1)</script> [x](javascript:alert(1)).\n");
    expect(out).toContain('href="/ar/legal/cgu#role"');
    expect(out).toMatch(/<article[^>]*><p[^>]*>Voir <a [^>]*href="\/ar\/legal\/cgu#role"/);
    expect(out).toMatch(/<a href="https:\/\/www\.cndp\.ma"[^>]* rel="noopener noreferrer">CNDP<\/a>/);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("javascript:");
  });

  it("keeps French punctuation on the line it closes", async () => {
    expect(await html("fr", "# T\n\nVersion 1\n\nNote : « oui » !\n")).toContain("Note : « oui » !");
  });

  it("maps only rif to the French formats", () => {
    expect(numbersLocale("rif")).toBe("fr");
    expect(numbersLocale("fr")).toBe("fr");
    expect(numbersLocale("ar")).toBe("ar");
    expect(new Intl.NumberFormat(numbersLocale("rif")).format(1200)).toBe(new Intl.NumberFormat("fr").format(1200));
  });
});
