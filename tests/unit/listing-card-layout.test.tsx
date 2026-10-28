import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { ListingCard } from "@/components/listing/listing-card";
import { FeaturedRow, withoutFeatured } from "@/components/search/featured-row";
import type { Locale } from "@/config/site";
import type { SearchCard } from "@/lib/search/types";

// Card layout fixes: a user-written title takes its own direction (a Latin title in Arabic keeps
// its punctuation and ellipsis on the right) yet aligns with the page; the À la Une band fills its
// row from md with wide cards, and the organic grid never repeats a card of the band.

vi.mock("@/lib/storage/keys", () => ({ mediaBaseUrl: () => "https://media.joutiya.test" }));

function render(node: ReactNode, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

function card(id: string, overrides: Partial<SearchCard> = {}): SearchCard {
  return {
    id,
    slugId: `velo-${id}`,
    title: `Vélo ${id}`,
    subcategoryId: "velos",
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    citySlug: "casablanca",
    photo: { id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
    photoCount: 1,
    sellerType: "individual",
    sortAt: "2026-10-16T10:00:00.000Z",
    bumped: false,
    featured: false,
    ...overrides,
  };
}

const MEDIA = "https://media.joutiya.test";

describe("ListingCard title", () => {
  it("lets the title pick its own direction and aligns it with the page side", () => {
    for (const locale of ["fr", "ar"] as const) {
      const html = render(<ListingCard listing={card("abcd2345", { title: "Yamaha NMax 125 !" })} mediaBaseUrl={MEDIA} locale={locale} />, locale);
      expect(html).toMatch(/<a [^>]*dir="auto"[^>]*>Yamaha NMax 125 !<\/a>/);
      expect(html).toMatch(/<h3 class="[^"]*ltr:text-left rtl:text-right[^"]*">/);
    }
  });
});

describe("example listing", () => {
  it("carries the Exemple chip and no action", () => {
    const html = render(<ListingCard listing={card("abcd2345", { example: true })} mediaBaseUrl={MEDIA} locale="fr" action={<button type="button">Favori</button>} />);
    expect(html).toContain('data-testid="example-chip"');
    expect(html).toContain(">Exemple<");
    expect(html).not.toContain("Favori");
    const plain = render(<ListingCard listing={card("abcd2345")} mediaBaseUrl={MEDIA} locale="fr" action={<button type="button">Favori</button>} />);
    expect(plain).not.toContain("example-chip");
    expect(plain).toContain("Favori");
  });
});

describe("À la Une band", () => {
  it("turns its cards wide from md so two of them fill the band", () => {
    const html = render(<FeaturedRow cards={[card("aaaa2345", { featured: true }), card("bbbb2345", { featured: true })]} locale="fr" />);
    expect(html).toMatch(/<ul class="[^"]*sm:grid-cols-2 lg:grid-cols-2"/);
    expect(html).not.toContain("lg:grid-cols-4");
    expect(html).not.toContain("md:col-span-2");
    expect(html.match(/md:flex-row/g)).toHaveLength(2);
    expect(html.match(/md:w-\[44%\]/g)).toHaveLength(2);
  });

  it("spans the band with a lone card", () => {
    const html = render(<FeaturedRow cards={[card("aaaa2345", { featured: true })]} locale="ar" />, "ar");
    expect(html).toContain('<li class="min-w-0 md:col-span-2">');
  });

  it("keeps the grid cards stacked", () => {
    const html = render(<ListingCard listing={card("abcd2345")} mediaBaseUrl={MEDIA} locale="fr" />);
    expect(html).not.toContain("md:flex-row");
    expect(html).not.toContain("md:w-[44%]");
  });
});

describe("withoutFeatured", () => {
  it("removes the band's cards from the organic results, order kept", () => {
    const hits = [card("aaaa2345"), card("bbbb2345"), card("cccc2345")];
    expect(withoutFeatured(hits, [card("bbbb2345", { featured: true })]).map((hit) => hit.id)).toEqual(["aaaa2345", "cccc2345"]);
    expect(withoutFeatured(hits, [])).toBe(hits);
    expect(withoutFeatured(hits, [card("zzzz2345")])).toEqual(hits);
  });
});
