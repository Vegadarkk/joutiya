import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UserRecord } from "@/lib/db/repositories/profiles";
import { isolate } from "@/lib/i18n/bidi";
import type * as Quota from "@/lib/quota";

// The public profile page module (lot D2, §5 /profil/{publicId}): ISR settings, 404 for unknown or
// hidden accounts, header, listing grid, empty state, metadata. Firestore and the request-scoped
// next-intl API are mocked.

const repo = vi.hoisted(() => ({
  findUserByPublicId: vi.fn<(publicId: string) => Promise<UserRecord | null>>(),
  listPublishedByOwner: vi.fn<(uid: string, limit?: number) => Promise<ListingRecord[]>>(),
  count: vi.fn<() => number>(),
}));
// The heart is a client island (app router hooks): its own tests cover it (phase 4).
vi.mock("@/components/favorites/favorite-button", () => ({ FavoriteButton: ({ listingId }: { listingId: string }) => <span data-favorite={listingId} /> }));
vi.mock("@/lib/db/repositories/listings", () => ({ getListing: vi.fn(), listPublishedByOwner: repo.listPublishedByOwner }));
vi.mock("@/lib/db/repositories/profiles", () => ({ findUserByPublicId: repo.findUserByPublicId, getUserRecord: vi.fn() }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), consume: vi.fn(), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/firebase/admin", () => {
  const query = { where: () => query, count: () => ({ get: async () => ({ data: () => ({ count: repo.count() }) }) }) };
  return { db: () => ({ collection: () => query }) };
});
vi.mock("@/lib/legal/config", () => ({ getLegalConfig: async () => ({ dsaContactEmail: "dsa@joutiya.test" }) }));
vi.mock("@/lib/storage/keys", () => ({ mediaBaseUrl: () => "https://media.joutiya.test" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
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
const page = await import("@/app/[locale]/(public)/profil/[publicId]/page");
const { default: ProfilePage, generateMetadata, generateStaticParams } = page;

const NOW = new Date("2026-10-16T10:00:00.000Z");
const PUBLIC_ID = "abcdefghjk";

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    uid: "uid-secret-1",
    publicId: PUBLIC_ID,
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

function listing(id: string, title: string): ListingRecord {
  return {
    id,
    ownerUid: "uid-secret-1",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: PUBLIC_ID,
    status: "published",
    slugId: `annonce-${id}`,
    title,
    description: "Description assez longue pour être publiée.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: {},
    price: 900,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos: [],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: NOW,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: true,
    publishedAt: NOW,
    expiresAt: NOW,
    legalHold: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };
}

const params = (publicId: string, locale = "fr") => ({ params: Promise.resolve({ locale, publicId }) });

async function renderPage(publicId = PUBLIC_ID): Promise<string> {
  const tree = await ProfilePage(params(publicId));
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      {tree}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  repo.findUserByPublicId.mockReset();
  repo.listPublishedByOwner.mockReset();
  repo.count.mockReset();
  vi.mocked(firstDegraded).mockReset();
  vi.mocked(firstDegraded).mockResolvedValue(null);
});

describe("profile page", () => {
  it("is ISR for 5 minutes and rendered on first visit", () => {
    expect(page.revalidate).toBe(300);
    expect(page.dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("answers 404 for unknown, closed, banned and never-activated accounts", async () => {
    repo.findUserByPublicId.mockResolvedValue(null);
    await expect(ProfilePage(params(PUBLIC_ID))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata(params(PUBLIC_ID))).toEqual({});
    for (const overrides of [{ status: "closed" }, { status: "banned" }, { activation: "pending" }] as const) {
      repo.findUserByPublicId.mockResolvedValue(user(overrides));
      await expect(ProfilePage(params(PUBLIC_ID))).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("fails the render before any read on a degraded-reads day, so Next keeps serving the last generated page", async () => {
    repo.findUserByPublicId.mockResolvedValue(user());
    vi.mocked(firstDegraded).mockResolvedValue("firestore.reads");
    await expect(ProfilePage(params(PUBLIC_ID))).rejects.toMatchObject({ status: 503, code: "quota_exhausted" });
    await expect(generateMetadata(params(PUBLIC_ID))).rejects.toMatchObject({ status: 503, code: "quota_exhausted" });
    expect(firstDegraded).toHaveBeenCalledWith(["firestore.reads"]);
    expect(repo.findUserByPublicId).not.toHaveBeenCalled();
  });

  it("shows the header and the grid of published listings, linked to their pages", async () => {
    repo.findUserByPublicId.mockResolvedValue(user());
    repo.listPublishedByOwner.mockResolvedValue([listing("abcd2345", "Vélo de ville"), listing("bcde3456", "Casque")]);
    const html = await renderPage();
    // The name keeps its own direction (dir="auto"), apart from the Pro badge.
    expect(html).toMatch(/<h1[^>]*><span dir="auto"[^>]*>Salma<\/span>/);
    expect(html).toContain("Membre depuis octobre 2025");
    expect(html).toContain("Téléphone vérifié");
    expect(html).toContain("2 annonces en ligne");
    expect(html.match(/data-testid="listing-card"/g)).toHaveLength(2);
    expect(html).toContain('href="/fr/annonce/annonce-abcd2345"');
    expect(html).toContain('href="/fr/annonce/annonce-bcde3456"');
    expect(html).toContain("mailto:dsa@joutiya.test");
    expect(html).not.toContain("uid-secret-1");
    expect(html).not.toContain(fr.Profile.emptyTitle);
  });

  it("says how many listings are hidden beyond the first page", async () => {
    repo.findUserByPublicId.mockResolvedValue(user());
    repo.listPublishedByOwner.mockResolvedValue(Array.from({ length: 24 }, (_, index) => listing(`abcd${"abcdefghjkmnpqrstuvwxyz2"[index]}234`, `Annonce ${index}`)));
    repo.count.mockReturnValue(30);
    const html = await renderPage();
    expect(html).toContain("30 annonces en ligne");
    expect(html).toContain("Les 24 annonces les plus récentes sont affichées.");
  });

  it("shows an empty state with a way forward, and a suspended account lists nothing", async () => {
    repo.findUserByPublicId.mockResolvedValue(user({ status: "suspended" }));
    const html = await renderPage();
    expect(html).toContain(fr.Profile.emptyTitle);
    expect(html).toContain('href="/fr/recherche"');
    expect(html).toContain("0 annonce en ligne");
    // The name inside the translated sentence is bidi-isolated.
    expect(html).toContain(fr.Profile.emptyBody.replace("{name}", isolate("Salma")));
    expect(repo.listPublishedByOwner).not.toHaveBeenCalled();
  });

  it("keeps a private seller out of search engines; a business with listings is indexable", async () => {
    repo.findUserByPublicId.mockResolvedValue(user());
    repo.listPublishedByOwner.mockResolvedValue([listing("abcd2345", "Vélo")]);
    const individual = await generateMetadata(params(PUBLIC_ID));
    expect(individual.title).toBe("Annonces de Salma");
    expect(individual.robots).toEqual({ index: false, follow: true });
    expect(individual.alternates).toMatchObject({ canonical: `/fr/profil/${PUBLIC_ID}` });

    repo.findUserByPublicId.mockResolvedValue(user({ type: "pro", displayName: "Garage Atlas" }));
    const business = await generateMetadata(params(PUBLIC_ID, "ar"));
    expect(business.robots).toBeUndefined();
    expect(business.alternates).toMatchObject({ canonical: `/ar/profil/${PUBLIC_ID}`, languages: { "fr-MA": `/fr/profil/${PUBLIC_ID}` } });
  });
});
