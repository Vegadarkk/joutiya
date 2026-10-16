import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { CityCombobox, groupByRegion } from "@/components/post/city-combobox";
import { cityBySlug, regionByCode, searchCities } from "@/config/regions";
import type { Locale } from "@/config/site";

const noop = () => undefined;

function render(props: Partial<Parameters<typeof CityCombobox>[0]>, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
      <CityCombobox value={null} onSelect={noop} locale={locale} {...props} />
    </NextIntlClientProvider>,
  );
}

const casablanca = cityBySlug("casablanca")!;

describe("groupByRegion", () => {
  it("groups the ranked cities by region, in first-appearance order, with localised names", () => {
    const cities = searchCities("", "fr", 12);
    const groups = groupByRegion(cities, "fr");
    expect(groups.flatMap((g) => g.cities).length).toBe(cities.length);
    expect(groups[0].cities[0]).toBe(cities[0]);
    for (const group of groups) {
      expect(group.name).toBe(regionByCode(group.code)!.nameFr);
      for (const city of group.cities) expect(city.regionCode).toBe(group.code);
    }
    expect(groupByRegion(cities, "ar")[0].name).toBe(regionByCode(groups[0].code)!.nameAr);
  });

  it("matches accents, apostrophes and the Arabic script", () => {
    expect(searchCities("casa", "fr").map((c) => c.slug)).toContain("casablanca");
    expect(searchCities("Tetouan", "fr")[0].slug).toBe("tetouan");
    expect(searchCities("الدار", "ar")[0].slug).toBe("casablanca");
    expect(searchCities("mdiq", "fr").map((c) => c.slug)).toContain("mdiq");
  });
});

describe("CityCombobox", () => {
  it("renders an ARIA combobox over the major cities before any typing", () => {
    const html = render({ required: true });
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-required="true"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain(`aria-label="${fr.Listing.fields.majorCities}"`);
    expect(html).toContain('id="');
    expect(html).toContain(`role="option"`);
    expect(html).toContain(">Casablanca<");
    // Closed until focused (the list is in the DOM for aria-controls but hidden).
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/role="listbox"[^>]*class="[^"]*hidden/);
    expect(html).toContain(fr.Listing.fields.cityPlaceholder);
  });

  it("names the listbox groups after the regions", () => {
    const html = render({});
    for (const group of groupByRegion(searchCities("", "fr", 12), "fr")) {
      expect(html).toContain(`>${group.name}<`);
      expect(html).toContain(`role="group" aria-labelledby="`);
    }
  });

  it("shows the chosen city with its region and a change button", () => {
    const html = render({ value: casablanca });
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain(">Casablanca<");
    expect(html).toContain(regionByCode(casablanca.regionCode)!.nameFr);
    expect(html).toContain(`>${fr.Listing.fields.changeCity}<`);
  });

  it("uses the Arabic names and messages", () => {
    const html = render({ value: casablanca }, "ar");
    expect(html).toContain(`>${casablanca.nameAr}<`);
    expect(html).toContain(regionByCode(casablanca.regionCode)!.nameAr);
    expect(html).toContain(`>${ar.Listing.fields.changeCity}<`);
    expect(render({}, "ar")).toContain(`>${casablanca.nameAr}<`);
  });

  it("announces the validation error", () => {
    const html = render({ error: "Choisissez une ville" });
    expect(html).toContain("Choisissez une ville");
    expect(html).toMatch(/role="combobox"[^>]*aria-invalid="true"/);
  });
});
