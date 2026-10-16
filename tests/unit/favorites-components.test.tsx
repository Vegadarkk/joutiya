import type { ReactNode } from "react";
import type * as NextNavigation from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { FavoriteCard, formatSavedDate } from "@/components/favorites/favorite-card";
import { FavoritesView } from "@/components/favorites/favorites-view";
import { UnsubscribeConfirm } from "@/components/alerts/unsubscribe-confirm";
import type { Locale } from "@/config/site";
import type { FavoriteView } from "@/lib/contracts/search";

// Server markup of the favorites islands (D17) and the unsubscribe confirm button (D20): the heart
// renders neutral (no pressed state) until the session is known, cards show the live listing or the
// greyed snapshot with "Plus disponible" and a remove action.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/favoris",
}));

function render(node: ReactNode, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const MEDIA = "https://media.joutiya.test";

const FAVORITE: FavoriteView = {
  listingId: "abcd2345",
  createdAt: "2026-10-12T10:00:00.000Z",
  available: true,
  card: {
    id: "abcd2345",
    slugId: "velo-de-ville-casablanca-abcd2345",
    title: "Vélo de ville",
    subcategoryId: "velos",
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    citySlug: "casablanca",
    photo: { id: "ph1", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
    photoCount: 3,
    sellerType: "individual",
    sortAt: "2026-10-12T10:00:00.000Z",
    bumped: false,
    featured: false,
  },
};

describe("FavoriteButton", () => {
  it("renders a neutral, named heart until the session is known", () => {
    const html = render(<FavoriteButton listingId="abcd2345" className="absolute top-1 end-1" />);
    expect(html).toContain(`aria-label="${fr.Favorites.button.label}"`);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("data-active");
    expect(html).toContain('type="button"');
    expect(html).toContain("absolute top-1 end-1");
    expect(html).toContain("size-11");
    expect(render(<FavoriteButton listingId="abcd2345" />, "ar")).toContain(`aria-label="${ar.Favorites.button.label}"`);
  });

  it("labels the inline variant of the listing page", () => {
    const html = render(<FavoriteButton listingId="abcd2345" variant="inline" />);
    expect(text(html)).toBe(fr.Favorites.button.add);
    expect(html).not.toContain("aria-label");
    expect(text(render(<FavoriteButton listingId="abcd2345" variant="inline" />, "ar"))).toBe(ar.Favorites.button.add);
  });
});

describe("FavoriteCard", () => {
  it("links an available listing, with its photo, price, city and a remove heart", () => {
    const html = render(<FavoriteCard favorite={FAVORITE} mediaBaseUrl={MEDIA} locale="fr" onRemove={() => undefined} />);
    expect(html).toContain('data-available="true"');
    expect(html).toContain('href="/fr/annonce/velo-de-ville-casablanca-abcd2345"');
    expect(html).toContain(`${MEDIA}/`);
    expect(html).toContain(`aria-label="${fr.Favorites.page.removeOf.replace("{title}", "Vélo de ville").replace(/'/g, "&#x27;")}"`);
    expect(text(html)).toContain("1 500 DH");
    expect(text(html)).toContain("Casablanca");
    expect(text(html)).toContain(`Ajoutée le ${formatSavedDate(FAVORITE.createdAt, "fr")}`);
    expect(text(html)).not.toContain(fr.Favorites.page.unavailable);
  });

  it("greys a listing gone, without link, with Plus disponible and a remove action", () => {
    const html = render(<FavoriteCard favorite={{ ...FAVORITE, available: false }} mediaBaseUrl={MEDIA} locale="fr" onRemove={() => undefined} />);
    expect(html).toContain('data-available="false"');
    expect(html).toContain("grayscale");
    expect(html).not.toContain("<a ");
    expect(text(html)).toContain(fr.Favorites.page.unavailable);
    expect(text(html)).toContain(fr.Favorites.page.remove);
    const arabic = render(<FavoriteCard favorite={{ ...FAVORITE, available: false }} mediaBaseUrl={null} locale="ar" onRemove={() => undefined} />, "ar");
    expect(text(arabic)).toContain(ar.Favorites.page.unavailable);
    expect(text(arabic)).toContain("الدار البيضاء");
  });

  it("formats the saved day as day and month", () => {
    expect(formatSavedDate("2026-10-12T12:00:00.000Z", "fr")).toBe("12 octobre");
    expect(formatSavedDate("2026-10-12T12:00:00.000Z", "ar")).toContain("أكتوبر");
  });
});

describe("FavoritesView", () => {
  it("starts on its loading state", () => {
    const html = render(<FavoritesView />);
    expect(html).toContain(fr.Favorites.page.loading);
  });
});

describe("UnsubscribeConfirm", () => {
  it("offers a single confirm button (the GET page never unsubscribes)", () => {
    const html = render(<UnsubscribeConfirm token="a.b" scope="all" />);
    expect(text(html)).toContain(fr.Alerts.unsubscribe.confirm);
    expect(html).toContain('type="button"');
    expect(html).not.toContain("<form");
  });
});
