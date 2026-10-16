import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { CriteriaFields } from "@/components/post/criteria-fields";
import { CONDITIONS, subcategoryById, type Subcategory } from "@/config/categories";
import type { Locale } from "@/config/site";
import type { ListingAttributes } from "@/lib/contracts/listings";

type CriteriaMessages = Record<string, { label: string; options?: Record<string, string> }>;
const criteriaMessages = (locale: Locale): CriteriaMessages => (locale === "ar" ? ar : fr).Criteria as CriteriaMessages;

const noop = () => undefined;

function render(subcategory: Subcategory, attributes: ListingAttributes = {}, locale: Locale = "fr", errors?: Record<string, string>) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
      <CriteriaFields subcategory={subcategory} attributes={attributes} condition={null} errors={errors} onAttribute={noop} onCondition={noop} />
    </NextIntlClientProvider>,
  );
}

const voitures = subcategoryById("voitures")!;
const location = subcategoryById("location")!;

describe("CriteriaFields", () => {
  it("renders every criterion of a car with its French label", () => {
    const html = render(voitures);
    const messages = criteriaMessages("fr");
    for (const criterion of voitures.criteria) {
      expect(html, criterion.id).toContain(messages[criterion.id]!.label);
    }
    // Condition first (the subcategory shows it), with every condition option.
    expect(html.indexOf(fr.Listing.fields.condition)).toBeLessThan(html.indexOf(messages["car-brand"]!.label));
    for (const condition of CONDITIONS) expect(html).toContain(messages["condition"]!.options![condition]);
  });

  it("picks the control from the criterion type", () => {
    const html = render(voitures, { year: 2019, mileage: 85000 });
    // Many brands: native select with the option labels; few fuels: radio chips.
    expect(html).toMatch(/<select[^>]*>[\s\S]*Dacia[\s\S]*<\/select>/);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain(criteriaMessages("fr")["fuel"]!.options!["diesel"]);
    // Numbers: numeric keypad, unit suffix for km (not for years), value echoed. React 19 keeps the
    // camelCase spelling of these attributes in its HTML (HTML attribute names are case-insensitive).
    expect(html).toMatch(/inputmode="numeric"/i);
    expect(html).toContain(`>${fr.Listing.units.km}<`);
    expect(html).not.toContain(`>${fr.Listing.units.an}<`);
    expect(html).toContain('value="85000"');
    expect(html).toContain('value="2019"');
    // Boolean: a switch; text: a bounded input.
    expect(html).toContain('role="switch"');
    expect(html).toMatch(/maxlength="80"/i);
  });

  it("renders multiselect amenities as checkbox chips with the chosen ones checked", () => {
    const html = render(location, { amenities: ["parking", "piscine"] });
    expect(html).toContain('role="group"');
    expect(html.match(/role="checkbox"/g)?.length).toBe(9);
    expect(html.match(/role="checkbox" aria-checked="true"/g)?.length).toBe(2);
    expect(html).toContain(criteriaMessages("fr")["amenities"]!.options!["piscine"]);
  });

  it("marks required criteria and shows the optional hint on the others", () => {
    const html = render(voitures);
    const stars = html.match(/aria-hidden="true">\*<\/span>/g)?.length ?? 0;
    expect(stars).toBe(voitures.criteria.filter((c) => c.required).length);
    expect(html).toContain(fr.Listing.wizard.optional);
  });

  it("shows field errors next to their control", () => {
    const html = render(voitures, {}, "fr", { "attributes.year": "Année invalide", condition: "Choisissez un état" });
    expect(html).toContain("Année invalide");
    expect(html).toContain("Choisissez un état");
    expect(html).toContain('aria-invalid="true"');
  });

  it("renders the Arabic labels", () => {
    const html = render(voitures, {}, "ar");
    const messages = criteriaMessages("ar");
    for (const criterion of voitures.criteria) expect(html, criterion.id).toContain(messages[criterion.id]!.label);
    expect(html).toContain(`>${ar.Listing.units.km}<`);
  });
});
