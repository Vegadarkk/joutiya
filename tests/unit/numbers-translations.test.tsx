import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import type { Locale } from "@/config/site";
import { useNumbersTranslations } from "@/i18n/numbers";

// Tarifit has no Intl data: under "rif" the French fallback text would print "1,200" and English
// plurals ("0 photos"). useNumbersTranslations formats it in French, like the server pages.

function Counts({ numbers }: { numbers: boolean }) {
  const plain = useTranslations("ListingCard");
  const french = useNumbersTranslations("ListingCard");
  const t = numbers ? french : plain;
  return <>{`${t("photos", { count: 0 })} / ${t("photos", { count: 1200 })}`}</>;
}

const render = (locale: Locale, numbers: boolean) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={fr} timeZone="Africa/Casablanca">
      <Counts numbers={numbers} />
    </NextIntlClientProvider>,
  );

describe("useNumbersTranslations", () => {
  const french = `0 photo / ${new Intl.NumberFormat("fr").format(1200)} photos`;

  it("formats the French fallback in French under rif", () => {
    expect(render("rif", true)).toBe(french);
    // What useTranslations prints there: the runtime default's digits and plural rules.
    expect(render("rif", false)).not.toBe(french);
  });

  it("is useTranslations itself elsewhere", () => {
    expect(render("fr", true)).toBe(french);
    expect(render("fr", false)).toBe(french);
  });
});
