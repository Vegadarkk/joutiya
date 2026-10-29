import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import type { ListingStatus } from "@/lib/contracts/listings";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UserRecord } from "@/lib/db/repositories/profiles";
import { isolate } from "@/lib/i18n/bidi";
import type * as Quota from "@/lib/quota";

// The public listing page module (lot D2: D1 canonical redirect, D14 404, §8 ISR settings, §5
// content, metadata and JSON-LD). Firestore, next/navigation and the request-scoped next-intl API
// are mocked; the async map block is replaced by a marker (renderToStaticMarkup is synchronous).

const repo = vi.hoisted(() => ({
  getListing: vi.fn<(id: string) => Promise<ListingRecord | null>>(),
  getUserRecord: vi.fn<(uid: string) => Promise<UserRecord | null>>(),
}));
vi.mock("@/lib/db/repositories/listings", () => ({ getListing: repo.getListing, listPublishedByOwner: vi.fn() }));
vi.mock("@/lib/db/repositories/profiles", () => ({ findUserByPublicId: vi.fn(), getUserRecord: repo.getUserRecord }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), consume: vi.fn(), firstDegraded: vi.fn(async () => null) }));
// The heart is a client island (app router hooks): its own tests cover it (phase 4).
vi.mock("@/components/favorites/favorite-button", () => ({ FavoriteButton: ({ listingId }: { listingId: string }) => <span data-favorite={listingId} /> }));
vi.mock("@/lib/firebase/admin", () => {
  const query = { where: () => query, count: () => ({ get: async () => ({ data: () => ({ count: 4 }) }) }) };
  return { db: () => ({ collection: () => query }) };
});
vi.mock("@/lib/legal/config", () => ({ getLegalConfig: async () => ({ dsaContactEmail: "dsa@joutiya.test" }) }));
vi.mock("@/lib/storage/keys", () => ({ mediaBaseUrl: () => "https://media.joutiya.test" }));
vi.mock("@/components/map/listing-map-block", () => ({
  ListingMapBlock: ({ citySlug, seed, className }: { citySlug: string; seed: string; className?: string }) => <div data-testid="map-block" data-city={citySlug} data-seed={seed} className={className} />,
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  permanentRedirect: (url: string) => {
    throw new Error(`NEXT_PERMANENT_REDIRECT ${url}`);
  },
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = { fr: (await import("../../messages/fr.json")).default, ar: (await import("../../messages/ar.json")).default };
  return {
    setRequestLocale: () => undefined,
    getTranslations: async ({ locale, namespace }: { locale: "fr" | "ar"; namespace?: string }) =>
      createTranslator({ locale, messages: messages[locale] ?? messages.fr, namespace: namespace as never }),
  };
});

const { firstDegraded } = await import("@/lib/quota");
const page = await import("@/app/[locale]/(public)/annonce/[slugId]/page");
const { default: ListingPage, generateMetadata, generateStaticParams } = page;

const ID = "abcd2345";
const SLUG_ID = `velo-de-ville-casablanca-${ID}`;
const NOW = new Date("2026-10-16T10:00:00.000Z");

function record(status: ListingStatus = "published", overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id: ID,
    ownerUid: "uid-secret-1",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: "abcdefghjk",
    status,
    slugId: SLUG_ID,
    title: "Vélo de ville",
    description: "Ligne 1\n\n  Ligne 2 <script>alert(1)</script>",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville" },
    condition: "good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos: [
      { id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef" },
      { id: "photo0002", w: 1200, h: 1600, blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH" },
    ],
    contact: { messaging: true, showPhone: true, whatsapp: true },
    boosts: {},
    sortAt: NOW,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 12, flags: ["new_account"], openReports: 0 },
    adsEligible: true,
    publishedAt: NOW,
    expiresAt: new Date("2026-12-15T10:00:00.000Z"),
    legalHold: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 3,
    ...overrides,
  };
}

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    uid: "uid-secret-1",
    publicId: "abcdefghjk",
    displayName: "Salma",
    type: "individual",
    citySlug: "casablanca",
    badges: { emailVerified: true, phoneVerified: true, proCertified: false },
    stats: { activeListings: 1, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: new Date("2025-10-05T12:00:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

const params = (slugId: string, locale = "fr") => ({ params: Promise.resolve({ locale, slugId }) });

async function renderPage(slugId = SLUG_ID, locale: "fr" | "ar" = "fr"): Promise<string> {
  const tree = await ListingPage(params(slugId, locale));
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {tree}
    </NextIntlClientProvider>,
  );
}

function jsonLd(html: string): Record<string, unknown> {
  const body = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!body) throw new Error("no JSON-LD block");
  return JSON.parse(body) as Record<string, unknown>;
}

/** Landing pages the breadcrumb links: the HTML hrefs and the BreadcrumbList `item` URLs. */
function crumbLinks(html: string): { html: string[]; ld: string[] } {
  const nav = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1] ?? "{}") as Record<string, unknown>);
  const list = blocks.find((block) => block["@type"] === "BreadcrumbList") as { itemListElement: { item?: string }[] } | undefined;
  return {
    html: [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? ""),
    ld: (list?.itemListElement ?? []).flatMap((step) => (step.item ? [step.item] : [])),
  };
}

beforeEach(() => {
  repo.getListing.mockReset();
  repo.getUserRecord.mockReset();
  repo.getUserRecord.mockResolvedValue(user());
  vi.mocked(firstDegraded).mockReset();
  vi.mocked(firstDegraded).mockResolvedValue(null);
});

describe("route settings (design §8)", () => {
  it("is ISR for 5 minutes, rendered on first visit, with no loading.tsx above it", () => {
    expect(page.revalidate).toBe(300);
    expect(page.dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
    // A loading boundary would stream a 200 before notFound() or the redirect could set the status.
    let dir = path.resolve("src/app/[locale]/(public)/annonce/[slugId]");
    while (dir !== path.resolve("src")) {
      expect(existsSync(path.join(dir, "loading.tsx")), dir).toBe(false);
      dir = path.dirname(dir);
    }
  });
});

describe("D1 canonical URL and D14 404", () => {
  it("redirects a wrong or missing slug to the canonical URL, permanently and in the same locale", async () => {
    repo.getListing.mockResolvedValue(record());
    await expect(ListingPage(params(`ancien-titre-${ID}`))).rejects.toThrow(`NEXT_PERMANENT_REDIRECT /fr/annonce/${SLUG_ID}`);
    await expect(ListingPage(params(ID, "ar"))).rejects.toThrow(`NEXT_PERMANENT_REDIRECT /ar/annonce/${SLUG_ID}`);
    await expect(ListingPage(params(`VELO-${ID}`))).rejects.toThrow(`NEXT_PERMANENT_REDIRECT /fr/annonce/${SLUG_ID}`);
    await expect(ListingPage(params(SLUG_ID.toUpperCase()))).rejects.toThrow(`NEXT_PERMANENT_REDIRECT /fr/annonce/${SLUG_ID}`);
    expect(repo.getListing).toHaveBeenLastCalledWith(ID);
    expect(await generateMetadata(params(`ancien-titre-${ID}`))).toEqual({});
  });

  it("answers 404 for a malformed id, a missing document and listings that are not public", async () => {
    await expect(ListingPage(params("pas-une-annonce"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(repo.getListing).not.toHaveBeenCalled();
    repo.getListing.mockResolvedValue(null);
    await expect(ListingPage(params(SLUG_ID))).rejects.toThrow("NEXT_NOT_FOUND");
    for (const status of ["draft", "pending_review", "rejected", "removed", "purged"] as const) {
      repo.getListing.mockResolvedValue(record(status));
      await expect(ListingPage(params(SLUG_ID)), status).rejects.toThrow("NEXT_NOT_FOUND");
      expect(await generateMetadata(params(SLUG_ID))).toEqual({});
    }
  });

  it("answers 404 for a published listing hidden by a report's strong signal (phase 5, D11)", async () => {
    repo.getListing.mockResolvedValue(record("published", { moderation: { state: "auto_ok", score: 12, flags: [], openReports: 1, hiddenBy: { reportId: "r1", signal: "multi", at: NOW } } }));
    await expect(ListingPage(params(SLUG_ID))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata(params(SLUG_ID))).toEqual({});
  });

  it("answers 404 for an unknown locale", async () => {
    repo.getListing.mockResolvedValue(record());
    await expect(ListingPage(params(SLUG_ID, "en"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("degraded Firestore reads (ISR cache)", () => {
  it("fails the render before any read, so Next keeps serving the last generated page", async () => {
    repo.getListing.mockResolvedValue(record());
    vi.mocked(firstDegraded).mockResolvedValue("firestore.reads");
    await expect(ListingPage(params(SLUG_ID))).rejects.toMatchObject({ status: 503, code: "quota_exhausted" });
    await expect(generateMetadata(params(SLUG_ID))).rejects.toMatchObject({ status: 503, code: "quota_exhausted" });
    expect(firstDegraded).toHaveBeenCalledWith(["firestore.reads"]);
    expect(repo.getListing).not.toHaveBeenCalled();
    expect(repo.getUserRecord).not.toHaveBeenCalled();
  });
});

describe("page content", () => {
  it("renders the title, price, place, criteria, description, seller, contact island, safety tips and map", async () => {
    repo.getListing.mockResolvedValue(record());
    const html = await renderPage();
    expect(html).toMatch(/<h1[^>]*>Vélo de ville<\/h1>/);
    expect(html).toContain("1 500 DH");
    expect(html).toContain(fr.ListingCard.negotiable);
    expect(html).toContain("Casablanca, Casablanca-Settat");
    expect(html).toContain('dateTime="2026-10-16T10:00:00.000Z"');
    expect(html).toContain('data-testid="criteria-grid"');
    expect(html).toContain('data-testid="seller-card"');
    expect(html).toContain('href="/fr/profil/abcdefghjk"');
    expect(html).toContain("4 annonces en ligne");
    expect(html).toContain('data-testid="contact-bar"');
    expect(html).toContain('data-testid="safety-tips"');
    expect(html).toContain('data-testid="map-block" data-city="casablanca" data-seed="abcd2345" class="w-full max-w-[26rem]"');
    // Report link, safety tips, then the ad slot: never an ad right after a contact or report control (D6).
    const report = html.indexOf(fr.Report.trigger.listing.replace(/'/g, "&#x27;"));
    const tips = html.indexOf('data-testid="safety-tips"');
    const ad = html.indexOf('data-ad-slot="listing-bottom"');
    expect(report).toBeGreaterThan(0);
    expect(tips).toBeGreaterThan(report);
    expect(ad).toBeGreaterThan(tips);
    expect(html.match(/data-ad-slot=/g)).toHaveLength(1);
    expect(html).toContain('data-ad-eligible="true"');
    expect(html).toContain(fr.Report.trigger.listing.replace(/'/g, "&#x27;"));
    expect(html).not.toContain('data-testid="listing-status"');
  });

  it("keeps the description's line breaks as plain, escaped text", async () => {
    repo.getListing.mockResolvedValue(record());
    const html = await renderPage();
    const description = /<div data-testid="listing-description"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    expect(description?.[0]).toContain("whitespace-pre-wrap");
    expect(description?.[1]).toBe("Ligne 1\n\n  Ligne 2 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("shows the seller's texts in their own direction: title, description, district and seller name", async () => {
    repo.getListing.mockResolvedValue(record("published", { location: { regionCode: "06", citySlug: "casablanca", district: "المعاريف", geo: { lat: 33.57, lng: -7.59 } } }));
    const html = await renderPage();
    expect(html).toMatch(/<h1 dir="auto"[^>]*>Vélo de ville<\/h1>/);
    expect(html).toMatch(/<div data-testid="listing-description" dir="auto" class="[^"]*\[unicode-bidi:plaintext\]/);
    expect(html).toContain(`Casablanca, ${isolate("المعاريف")}, Casablanca-Settat`);
    expect(html).toMatch(/<span aria-current="page" dir="auto"[^>]*>Vélo de ville<\/span>/);
    expect(html).toMatch(/<a dir="auto"[^>]*href="\/fr\/profil\/abcdefghjk"[^>]*>Salma<\/a>/);
    // The gallery's alt texts isolate the title inside the translated sentence.
    expect(html).toContain(`alt="${isolate("Vélo de ville")}, photo 1 sur 2"`);
  });

  it("joins the city and the district with the locale's separator (an Arabic comma in Arabic)", async () => {
    repo.getListing.mockResolvedValue(record("published", { location: { regionCode: "06", citySlug: "casablanca", district: "Maârif (près du parc)", geo: { lat: 33.57, lng: -7.59 } } }));
    const district = isolate("Maârif (près du parc)");
    expect(await renderPage()).toContain(`Casablanca, ${district}, Casablanca-Settat`);
    const html = await renderPage(SLUG_ID, "ar");
    expect(html).toContain(`الدار البيضاء، ${district}، الدار البيضاء-سطات`);
    expect(html).not.toContain("الدار البيضاء,");
  });

  it("offers the m variant in the gallery's srcset for photos that have it (D6), not for legacy ones", async () => {
    const [first, second] = record().photos;
    repo.getListing.mockResolvedValue(record("published", { photos: [{ ...first!, variants: ["l", "m", "s"] }, second!] }));
    const html = await renderPage();
    expect(html).toContain("/listings/abcd2345/photo0001-m.webp 960w");
    expect(html).not.toContain("photo0002-m.webp");
  });

  it("never prints the uid, the moderation data, the geo point or a phone number", async () => {
    repo.getListing.mockResolvedValue(record());
    const html = await renderPage();
    for (const secret of ["uid-secret-1", "new_account", "auto_ok", "33.57", "-7.59", "0123456789abcdef", "tel:", "+212"]) expect(html, secret).not.toContain(secret);
  });

  it("links the breadcrumb to the category landing pages, with a BreadcrumbList and the heart", async () => {
    repo.getListing.mockResolvedValue(record());
    const html = await renderPage();
    expect(html).toContain('href="/fr/c/vehicules"');
    expect(html).toContain('href="/fr/c/vehicules/velos"');
    expect(html).toContain('href="/fr/c/vehicules/velos/casablanca"');
    expect(html).not.toContain("/recherche?");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).toMatch(/data-favorite="[^"]+"/);
    expect(crumbLinks(html)).toEqual({
      html: ["/fr", "/fr/c/vehicules", "/fr/c/vehicules/velos", "/fr/c/vehicules/velos/casablanca"],
      ld: ["https://joutiya.ma/fr", "https://joutiya.ma/fr/c/vehicules", "https://joutiya.ma/fr/c/vehicules/velos", "https://joutiya.ma/fr/c/vehicules/velos/casablanca"],
    });
  });

  it("links only /c/{category} for a listing its deeper landing pages do not count (they may 404, D15)", async () => {
    const outOfIndex = (["sold", "paused", "expired"] as const).map((status) => record(status));
    for (const listing of outOfIndex) {
      repo.getListing.mockResolvedValue(listing);
      const html = await renderPage();
      expect(crumbLinks(html), listing.status).toEqual({ html: ["/fr", "/fr/c/vehicules"], ld: ["https://joutiya.ma/fr", "https://joutiya.ma/fr/c/vehicules"] });
    }
  });

  it("skips a subcategory /c no longer resolves: the city step falls back to /c/{category}/{city}", async () => {
    repo.getListing.mockResolvedValue(record("published", { subcategoryId: "retiree", attributes: {} }));
    const html = await renderPage();
    expect(crumbLinks(html).html).toEqual(["/fr", "/fr/c/vehicules", "/fr/c/vehicules/casablanca"]);
    // A subcategory of another category is not a step of this one either.
    repo.getListing.mockResolvedValue(record("published", { subcategoryId: "colocation", attributes: {} }));
    expect(crumbLinks(await renderPage()).html).toEqual(["/fr", "/fr/c/vehicules", "/fr/c/vehicules/casablanca"]);
  });

  it("shows a banner and no contact action for a sold, paused or expired listing", async () => {
    for (const status of ["sold", "paused", "expired"] as const) {
      repo.getListing.mockResolvedValue(record(status));
      const html = await renderPage();
      expect(html).toContain(`data-state="${status}"`);
      expect(html, status).not.toContain('data-testid="contact-bar"');
      expect(html).toContain('data-testid="seller-card"');
      // Still a house promotion, never an ad: only a published listing carries ads.
      expect(html).toContain('data-ad-slot="listing-bottom"');
      expect(html, status).not.toContain("data-ad-eligible");
    }
  });

  it("labels an example listing and offers no contact, favorite or Product markup", async () => {
    repo.getListing.mockResolvedValue(record("published", { example: true }));
    const html = await renderPage();
    expect(html).toContain('data-testid="example-banner"');
    expect(html).toContain("Annonce exemple");
    expect(html).toContain('data-testid="example-contact"');
    expect(html).not.toContain('data-testid="contact-bar"');
    expect(html).not.toContain("data-favorite=");
    expect(html).not.toContain('"@type":"Product"');
    const metadata = await generateMetadata(params(SLUG_ID));
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("keeps the page readable with the denormalized seller when the account has no public face", async () => {
    repo.getListing.mockResolvedValue(record());
    repo.getUserRecord.mockResolvedValue(user({ status: "banned" }));
    const banned = await renderPage();
    expect(banned).toContain("Salma");
    expect(banned).not.toContain("/profil/");
    repo.getUserRecord.mockRejectedValue(new Error("firestore down"));
    expect(await renderPage()).toContain('data-testid="seller-card"');
  });
});

describe("JSON-LD", () => {
  it("publishes a Product with an Offer in MAD, the availability and condition, and no seller data", async () => {
    repo.getListing.mockResolvedValue(record());
    const html = await renderPage();
    const data = jsonLd(html);
    expect(data).toMatchObject({
      "@type": "Product",
      name: "Vélo de ville",
      url: `https://joutiya.ma/fr/annonce/${SLUG_ID}`,
      image: ["https://media.joutiya.test/listings/abcd2345/photo0001-l.webp", "https://media.joutiya.test/listings/abcd2345/photo0002-l.webp"],
      offers: { "@type": "Offer", price: "1500", priceCurrency: "MAD", availability: "https://schema.org/InStock", itemCondition: "https://schema.org/UsedCondition" },
    });
    const block = JSON.stringify(data);
    for (const secret of ["Salma", "abcdefghjk", "uid-secret-1", "33.57", "telephone", "+212"]) expect(block, secret).not.toContain(secret);
    // The seller's text cannot close the data blocks (Product + BreadcrumbList).
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
  });

  it("marks a sold listing SoldOut", async () => {
    repo.getListing.mockResolvedValue(record("sold"));
    expect((jsonLd(await renderPage()).offers as { availability: string }).availability).toBe("https://schema.org/SoldOut");
  });
});

describe("metadata", () => {
  it("has the title, description, canonical, fr/ar alternates and the first photo as OG image", async () => {
    repo.getListing.mockResolvedValue(record());
    const metadata = await generateMetadata(params(SLUG_ID));
    expect(metadata.title).toBe("Vélo de ville à Casablanca");
    expect(metadata.description).toBe("1 500 DH. Ligne 1 Ligne 2 <script>alert(1)</script>");
    expect(metadata.alternates).toEqual({
      canonical: `/fr/annonce/${SLUG_ID}`,
      languages: { "fr-MA": `/fr/annonce/${SLUG_ID}`, "ar-MA": `/ar/annonce/${SLUG_ID}`, "x-default": `/fr/annonce/${SLUG_ID}` },
    });
    expect(metadata.openGraph).toMatchObject({ url: `/fr/annonce/${SLUG_ID}`, images: [{ url: "https://media.joutiya.test/listings/abcd2345/photo0001-l.webp", width: 1600, height: 1200 }] });
    expect(metadata.robots).toBeUndefined();
  });

  it("caps the description and keeps paused, sold and expired pages out of search engines", async () => {
    repo.getListing.mockResolvedValue(record("expired", { description: "mot ".repeat(200), price: null, priceNegotiable: false, subcategoryId: "location", categoryId: "immobilier" }));
    const metadata = await generateMetadata(params(SLUG_ID));
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
    expect(String(metadata.description).startsWith(`${fr.ListingCard.toDiscuss}. mot`)).toBe(true);
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("has no OG image without photo, and Tarifit stays out of the hreflang cluster", async () => {
    repo.getListing.mockResolvedValue(record("published", { photos: [] }));
    const metadata = await generateMetadata(params(SLUG_ID, "rif"));
    expect(metadata.openGraph?.images).toBeUndefined();
    expect(metadata.alternates).toEqual({ canonical: `/rif/annonce/${SLUG_ID}` });
  });
});
