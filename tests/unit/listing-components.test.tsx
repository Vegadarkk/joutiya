import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { AdSlot } from "@/components/listing/ad-slot";
import { Breadcrumb, SEARCH_QUERY, searchHref } from "@/components/listing/breadcrumb";
import { CriteriaGrid, CriteriaSection } from "@/components/listing/criteria-grid";
import { ListingCard } from "@/components/listing/listing-card";
import { ListingStatusBanner } from "@/components/listing/listing-status-banner";
import { PriceTag } from "@/components/listing/price-tag";
import { ReportLink, reportMailto } from "@/components/listing/report-link";
import { SafetyTips } from "@/components/listing/safety-tips";
import { formatMemberSince, initialOf, SellerCard } from "@/components/listing/seller-card";
import type { Locale } from "@/config/site";
import type { PublicListingCard, PublicSeller } from "@/lib/listings/public";

// Server-rendered markup of the listing page and profile building blocks (lot D2).

function render(node: ReactNode, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

/** Text content, tags stripped and entities of the markup decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** A message as React prints it inside an attribute or text. */
const escape = (value: string) => value.replace(/'/g, "&#x27;");

const MEDIA = "https://media.joutiya.test";
/** Digit groups are joined by U+202F, the amount and the currency by U+00A0 (format.ts). */
const NNBSP = "\u202f";
const NBSP = "\u00a0";

describe("PriceTag", () => {
  it("shows an integer MAD amount with grouped digits, negotiable and the rental unit", () => {
    const html = render(<PriceTag price={1500} isDonation={false} negotiable locale="fr" />);
    expect(html).toContain(`1${NNBSP}500${NBSP}DH`);
    expect(html).toContain(fr.ListingCard.negotiable);
    expect(render(<PriceTag price={4000} isDonation={false} unit="month" locale="fr" />)).toContain(fr.ListingCard.per.month);
    expect(render(<PriceTag price={1250000} isDonation={false} locale="ar" />, "ar")).toContain(`1${NNBSP}250${NNBSP}000${NBSP}درهم`);
  });

  it("says donation or price to discuss without an amount, unit or negotiable mark", () => {
    const donation = render(<PriceTag price={0} isDonation negotiable unit="night" locale="fr" />);
    expect(text(donation)).toBe(fr.ListingCard.donation);
    const toDiscuss = render(<PriceTag price={null} isDonation={false} negotiable unit="month" locale="fr" />);
    expect(text(toDiscuss)).toBe(fr.ListingCard.toDiscuss);
    expect(text(render(<PriceTag price={null} isDonation={false} locale="ar" />, "ar"))).toBe(ar.ListingCard.toDiscuss);
  });
});

describe("CriteriaGrid", () => {
  it("lists the condition first, then the subcategory's filled fields in config order with labels and units", () => {
    const html = render(
      <CriteriaGrid
        subcategoryId="voitures"
        condition="very_good"
        attributes={{ "car-brand": "dacia", model: "Logan", year: 2019, mileage: 120000, fuel: "diesel", gearbox: "manuelle", "first-hand": true }}
      />,
    );
    const labels = [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((match) => match[1]);
    expect(labels).toEqual(["État", "Marque", "Modèle", "Année-modèle", "Kilométrage", "Carburant", "Boîte de vitesses", "Première main"]);
    const values = [...html.matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map((match) => match[1]);
    expect(values).toEqual(["Très bon état", "Dacia", "Logan", "2019", `120${NNBSP}000 km`, "Diesel", "Manuelle", "Oui"]);
  });

  it("joins multiselect options, renders surfaces in m² and skips empty values", () => {
    const html = render(<CriteriaGrid subcategoryId="location" condition={null} attributes={{ "property-type": "appartement", surface: 85, furnished: false, amenities: ["parking", "ascenseur"], deposit: "" }} />);
    expect(text(html)).toContain("85 m²");
    expect(text(html)).toContain("Parking, Ascenseur");
    expect(text(html)).toContain(`${fr.Criteria.furnished.label} ${fr.ListingPage.criteria.no}`);
    expect(html).not.toContain(fr.Criteria.condition.label);
  });

  it("escapes free text typed by the seller", () => {
    const html = render(<CriteriaGrid subcategoryId="voitures" condition={null} attributes={{ model: '<img src=x onerror="alert(1)">' }} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
  });

  it("renders nothing (no heading either) when no criterion is filled", () => {
    expect(render(<CriteriaGrid subcategoryId="voitures" condition={null} attributes={{}} />)).toBe("");
    expect(render(<CriteriaSection title="Caractéristiques" subcategoryId="unknown-sub" condition="good" attributes={{ a: "b" }} />)).toBe("");
    expect(render(<CriteriaSection title="Caractéristiques" subcategoryId="velos" condition="good" attributes={{}} />)).toContain('<h2 id="criteria-title"');
  });
});

const card: PublicListingCard = {
  id: "abcd2345",
  slugId: "velo-de-ville-casablanca-abcd2345",
  title: "Vélo de ville",
  subcategoryId: "velos",
  price: 1500,
  priceNegotiable: false,
  isDonation: false,
  citySlug: "casablanca",
  photo: { id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
  photoCount: 3,
  sellerType: "individual",
  sortAt: "2026-10-16T10:00:00.000Z",
};

describe("ListingCard", () => {
  it("links the whole card to the localized listing page, without prefetch", () => {
    const html = render(<ListingCard listing={card} mediaBaseUrl={MEDIA} locale="fr" />);
    expect(html).toContain('href="/fr/annonce/velo-de-ville-casablanca-abcd2345"');
    expect(html).toMatch(/<h3[^>]*><a /);
    expect(text(html)).toContain("Vélo de ville");
    expect(html).toContain(`1${NNBSP}500${NBSP}DH`);
    expect(text(html)).toContain("Casablanca");
    expect(html).toContain('dateTime="2026-10-16T10:00:00.000Z"');
  });

  it("loads the small variant lazily with both variants in srcset and its intrinsic size", () => {
    const html = render(<ListingCard listing={card} mediaBaseUrl={MEDIA} locale="fr" />);
    const img = /<img[^>]*>/.exec(html)?.[0] ?? "";
    expect(img).toContain(`src="${MEDIA}/listings/abcd2345/photo0001-s.webp"`);
    expect(img).toContain(`srcSet="${MEDIA}/listings/abcd2345/photo0001-s.webp 480w, ${MEDIA}/listings/abcd2345/photo0001-l.webp 1600w"`);
    expect(img).toContain('width="1600" height="1200"');
    expect(img).toContain('loading="lazy"');
    expect(img).toContain('decoding="async"');
    expect(img).toContain('alt=""');
    expect(html).toContain("background-image:url(&quot;data:image/bmp;base64,");
    expect(text(html)).toContain("3 photos");
  });

  it("shows a placeholder without photo or media host, and the Pro badge", () => {
    const html = render(<ListingCard listing={{ ...card, photo: null, photoCount: 0, sellerType: "pro" }} mediaBaseUrl={MEDIA} locale="fr" />);
    expect(html).not.toContain("<img");
    expect(text(html)).toContain(fr.ListingCard.noPhoto);
    expect(text(html)).toContain(fr.ListingCard.pro);
    expect(render(<ListingCard listing={card} mediaBaseUrl={null} locale="fr" />)).not.toContain("<img");
  });

  it("uses Arabic city names and the Arabic currency in Arabic", () => {
    const html = render(<ListingCard listing={card} mediaBaseUrl={MEDIA} locale="ar" />, "ar");
    expect(html).toContain('href="/ar/annonce/velo-de-ville-casablanca-abcd2345"');
    expect(text(html)).toContain("الدار البيضاء");
    expect(text(html)).toContain("درهم");
  });
});

const seller: PublicSeller = {
  publicId: "abcdefghjk",
  displayName: "Salma",
  sellerType: "individual",
  memberSince: "2025-10",
  badges: { emailVerified: true, phoneVerified: true, proCertified: false },
  citySlug: "casablanca",
  publishedCount: 2,
};

describe("SellerCard", () => {
  it("names the seller, links the profile and shows seniority, city, badges and listings online", () => {
    const html = render(<SellerCard seller={seller} fallbackName="ignored" fallbackType="individual" locale="fr" />);
    expect(html.match(/href="\/fr\/profil\/abcdefghjk"/g)).toHaveLength(2);
    const content = text(html);
    expect(content).toContain("Particulier");
    expect(content).toContain("Salma");
    expect(content).toContain("Membre depuis octobre 2025");
    expect(content).toContain("Casablanca");
    expect(content).toContain("Téléphone vérifié");
    expect(content).toContain("E-mail vérifié");
    expect(content).not.toContain("Pro certifié");
    expect(content).toContain("2 annonces en ligne");
    expect(html).not.toContain("ignored");
  });

  it("falls back to the denormalized name, without profile link, when the account has no public face", () => {
    const html = render(<SellerCard seller={null} fallbackName="Garage Atlas" fallbackType="pro" locale="fr" />);
    expect(html).not.toContain("/profil/");
    expect(text(html)).toContain("Garage Atlas");
    expect(text(html)).toContain("Professionnel");
    expect(text(html)).not.toContain("Membre depuis");
  });

  it("renders its children (the contact island) under the identity", () => {
    expect(render(<SellerCard seller={seller} fallbackName="" fallbackType="individual" locale="fr"><p>contact</p></SellerCard>)).toContain("<p>contact</p></section>");
  });

  it("formats the month of registration and the initial in any script", () => {
    expect(formatMemberSince("2025-10", "fr")).toBe("octobre 2025");
    expect(formatMemberSince("2025-10", "ar")).toContain("2025");
    expect(formatMemberSince("bad", "fr")).toBe("bad");
    expect(initialOf("  salma")).toBe("S");
    expect(initialOf("سلمى")).toBe("س");
    expect(initialOf("")).toBe("?");
  });
});

describe("ListingStatusBanner", () => {
  it("says nothing for a published listing", () => {
    expect(render(<ListingStatusBanner state="published" />)).toBe("");
  });

  it("explains paused, sold and expired listings in a status region", () => {
    for (const state of ["paused", "sold", "expired"] as const) {
      const html = render(<ListingStatusBanner state={state} />);
      expect(html).toContain('role="status"');
      expect(html).toContain(`data-state="${state}"`);
      expect(text(html)).toContain(fr.ListingPage.status[state].title);
      expect(html).toContain('href="/fr/recherche"');
    }
  });
});

describe("ReportLink", () => {
  it("writes a mailto to the DSA contact with the content's id and URL, spaces as %20", () => {
    const href = reportMailto("dsa@joutiya.ma", "Signalement de l'annonce abcd2345", "Adresse : https://joutiya.ma/fr/annonce/x-abcd2345");
    expect(href.startsWith("mailto:dsa@joutiya.ma?subject=")).toBe(true);
    expect(href).not.toContain("+");
    expect(decodeURIComponent(href)).toContain("Signalement de l'annonce abcd2345");
    const html = render(<ReportLink email="dsa@joutiya.ma" target="listing" id="abcd2345" url="https://joutiya.ma/fr/annonce/x-abcd2345" />);
    expect(text(html)).toContain(fr.ListingPage.report.listing.link);
    expect(html).toContain("mailto:dsa@joutiya.ma?subject=Signalement%20de%20l");
    expect(render(<ReportLink email="dsa@joutiya.ma" target="profile" id="abcdefghjk" url="https://joutiya.ma/fr/profil/abcdefghjk" />)).toContain(escape(fr.ListingPage.report.profile.link));
  });
});

describe("AdSlot", () => {
  it("reserves the height of the future ad and fills it with a house promotion", () => {
    const aside = render(<AdSlot slot="listing-aside" />);
    expect(aside).toContain('data-ad-slot="listing-aside"');
    expect(aside).toContain("min-h-[250px]");
    expect(aside).toContain(`aria-label="${fr.ListingPage.ad.label}"`);
    expect(aside).toContain('href="/fr/deposer"');
    expect(render(<AdSlot slot="profile-bottom" />)).toContain("min-h-[100px]");
    expect(aside).not.toContain("<script");
  });
});

describe("Breadcrumb", () => {
  it("links each step to the filtered search and marks the listing as the current page", () => {
    expect(searchHref({ category: "vehicules", subcategory: "velos", city: "casablanca" })).toEqual({
      pathname: "/recherche",
      query: { [SEARCH_QUERY.category]: "vehicules", [SEARCH_QUERY.subcategory]: "velos", [SEARCH_QUERY.city]: "casablanca" },
    });
    const html = render(
      <Breadcrumb
        current="Vélo de ville"
        items={[
          { label: "Accueil", href: "/" },
          { label: "Véhicules", href: searchHref({ category: "vehicules" }) },
        ]}
      />,
    );
    expect(html).toContain(`aria-label="${escape(fr.ListingPage.breadcrumb)}"`);
    expect(html).toContain('href="/fr"');
    expect(html).toContain('href="/fr/recherche?categorie=vehicules"');
    expect(html).toContain('<span aria-current="page"');
    expect(html).toContain("rtl:-scale-x-100");
  });
});

describe("SafetyTips", () => {
  it("gives the tips and the neutral host statement, with a link to the trust page", () => {
    const html = render(<SafetyTips />);
    expect(text(html)).toContain(fr.ListingPage.safety.tips.noAdvance);
    expect(text(html)).toContain(fr.ListingPage.safety.host);
    expect(html).toContain('href="/fr/legal/confiance-et-securite"');
    expect(text(render(<SafetyTips />, "ar"))).toContain(ar.ListingPage.safety.title);
  });
});
