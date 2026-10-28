import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { DEFAULT_LEGAL } from "@/config/legal";
import type { Locale } from "@/config/site";
import { LegalPage } from "@/components/legal/legal-page";
import { LEGAL_TEXTS } from "@/content/legal/fr";
import { legalValues } from "@/content/legal/mentions";
import { loadMessages } from "@/i18n/messages";
import { numbersLocale } from "@/i18n/params";

// Tarifit has no Intl data (the runtime falls back to en-US): the legal pages print their date in
// the French form under "rif", while the request locale stays "rif".

const text = LEGAL_TEXTS.cgu;

async function updatedLine(locale: Locale): Promise<string> {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={await loadMessages(locale)} timeZone="Africa/Casablanca">
      <LegalPage locale={locale} title="CGU" text={text} values={legalValues(DEFAULT_LEGAL)} />
    </NextIntlClientProvider>,
  );
  return /<p class="mt-3 text-sm text-foreground-muted">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
}

describe("LegalPage", () => {
  it("formats the update date under rif exactly as under fr", async () => {
    const fr = await updatedLine("fr");
    expect(fr).toBe(`Mise à jour : ${new Intl.DateTimeFormat("fr", { dateStyle: "long", timeZone: "Africa/Casablanca" }).format(new Date(`${text.updated}T12:00:00Z`))}`);
    expect(fr).toMatch(/^Mise à jour : \d{1,2} \S+ \d{4}$/);
    expect(await updatedLine("rif")).toBe(fr);
    expect(await updatedLine("ar")).toContain("آخر تحديث");
  });

  it("maps only rif to the French formats", () => {
    expect(numbersLocale("rif")).toBe("fr");
    expect(numbersLocale("fr")).toBe("fr");
    expect(numbersLocale("ar")).toBe("ar");
    expect(new Intl.NumberFormat(numbersLocale("rif")).format(1200)).toBe(new Intl.NumberFormat("fr").format(1200));
  });
});

// Optional mentions (`ifSet` blocks): the CNDP sentence appears only with a receipt number (C2-05).

async function privacyPage(cndpReceiptNo: string): Promise<string> {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={await loadMessages("fr")} timeZone="Africa/Casablanca">
      <LegalPage locale="fr" title="Confidentialité" text={LEGAL_TEXTS.confidentialite} values={legalValues({ ...DEFAULT_LEGAL, cndpReceiptNo })} />
    </NextIntlClientProvider>,
  );
}

describe("LegalPage optional blocks", () => {
  it("leaves the CNDP sentence out while no declaration is filed", async () => {
    const html = await privacyPage("");
    expect(html).not.toContain("Déclaration auprès de la CNDP");
    expect(html).not.toContain("en cours</p>");
    // The rights paragraph around it still renders.
    expect(html).toContain("la CNDP (cndp.ma).");
  });

  it("renders it with the receipt number once configured", async () => {
    expect(await privacyPage("D-123/2027")).toContain("<p>Déclaration auprès de la CNDP\u00a0: récépissé n° D-123/2027.</p>");
  });
});
