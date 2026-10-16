import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { PriceInput, type PriceInputProps } from "@/components/post/price-input";
import type { Locale } from "@/config/site";

const noop = () => undefined;
const base: PriceInputProps = {
  value: null,
  onChange: noop,
  negotiable: false,
  onNegotiable: noop,
  isDonation: false,
  onDonation: noop,
  donationAllowed: false,
  priceOptional: false,
};

function render(props: Partial<PriceInputProps>, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
      <PriceInput {...base} locale={locale} {...props} />
    </NextIntlClientProvider>,
  );
}

// React 19 writes `inputMode` in camelCase (HTML attribute names are case-insensitive).
const inputValue = (html: string) => /<input[^>]*inputmode="numeric"[^>]*>/i.exec(html)?.[0].match(/ value="([^"]*)"/)?.[1];
const inputTag = (html: string) => /<input[^>]*inputmode="numeric"[^>]*>/i.exec(html)?.[0] ?? "";

describe("PriceInput", () => {
  it("groups the digits of the amount and shows the currency", () => {
    const html = render({ value: 1500 });
    expect(inputValue(html)).toBe("1 500");
    expect(html).toContain(">DH<");
    expect(html).toMatch(/inputmode="numeric"/i);
    expect(html).toContain('dir="ltr"');
  });

  it("formats large amounts and the Arabic currency", () => {
    expect(inputValue(render({ value: 1250000 }))).toBe("1 250 000");
    expect(render({ value: 1500 }, "ar")).toContain(">درهم<");
  });

  it("shows the unit under the currency for rentals", () => {
    const html = render({ value: 4000, priceUnit: "month" });
    expect(html).toContain(fr.Listing.fields.per.month);
    expect(render({ value: 400, priceUnit: "night" })).toContain(fr.Listing.fields.per.night);
  });

  it("offers the switches the subcategory allows", () => {
    const plain = render({});
    expect(plain.match(/role="switch"/g)?.length).toBe(1);
    expect(plain).toContain(fr.Listing.fields.negotiable);
    expect(plain).not.toContain(fr.Listing.fields.donation);
    expect(plain).not.toContain(fr.Listing.fields.toDiscuss);

    const full = render({ donationAllowed: true, priceOptional: true, value: 10 });
    expect(full.match(/role="switch"/g)?.length).toBe(3);
    expect(full).toContain(fr.Listing.fields.donation);
    expect(full).toContain(fr.Listing.fields.toDiscuss);
  });

  it("marks the amount required unless the price is optional or a donation", () => {
    expect(render({})).toContain('aria-required="true"');
    expect(render({ priceOptional: true, value: 20 })).not.toContain('aria-required="true"');
    expect(render({ donationAllowed: true, isDonation: true })).not.toContain('aria-required="true"');
  });

  it("disables the amount for a donation or an undecided price", () => {
    const donation = render({ donationAllowed: true, isDonation: true });
    expect(inputValue(donation)).toBe("0");
    expect(donation).toMatch(/<input[^>]*inputmode="numeric"[^>]*disabled/i);
    expect(donation).toContain('role="switch" aria-checked="true"');

    const toDiscuss = render({ priceOptional: true, value: null });
    expect(inputValue(toDiscuss)).toBe("");
    expect(toDiscuss).toMatch(/<input[^>]*inputmode="numeric"[^>]*disabled/i);
  });

  it("shows the validation message", () => {
    const html = render({ error: "Indiquez un prix" });
    expect(html).toContain("Indiquez un prix");
    expect(inputTag(html)).toContain('aria-invalid="true"');
  });

  it("names the input with its label (id, aria-required and the hint land on the input, not the wrapper)", () => {
    const html = render({});
    const id = /<label for="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(inputTag(html)).toContain(`id="${id}"`);
    expect(inputTag(html)).toContain('aria-required="true"');
    expect(inputTag(html)).toContain(`aria-describedby="${id}-hint"`);
  });
});
