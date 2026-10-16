import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { OwnerListingCard } from "@/components/listings/owner/owner-listing-card";
import type { Locale } from "@/config/site";
import type { ListingStatus, OwnerListingSummary } from "@/lib/contracts/listings";
import { isolate } from "@/lib/i18n/bidi";

// One row of "Mes annonces" (server markup): bidi-isolated titles in the translated labels,
// accessible names that start with the visible label (WCAG 2.5.3), heading level, and the phone
// layout where the primary action takes the full row under the cover.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  usePathname: () => "/mes-annonces",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

const NOW = new Date("2026-10-16T10:00:00.000Z");

function summary(status: ListingStatus, overrides: Partial<OwnerListingSummary> = {}): OwnerListingSummary {
  return {
    id: "abcd2345",
    slugId: status === "draft" ? null : "velo-de-ville-casablanca-abcd2345",
    status,
    title: "Vélo de ville",
    price: 1500,
    isDonation: false,
    categoryId: "loisirs",
    subcategoryId: "velos",
    citySlug: "casablanca",
    thumb: null,
    photoCount: 0,
    moderation: { state: "auto_ok", flags: [] },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    publishedAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-10-19T00:00:00.000Z",
    canRenew: false,
    ...overrides,
  };
}

const noop = async () => undefined;

function render(listing: OwnerListingSummary, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      <OwnerListingCard listing={listing} mediaBaseUrl="https://media.joutiya.test" onAction={noop} onDelete={noop} now={NOW} />
    </NextIntlClientProvider>,
  );
}

/** aria-label values of the markup, entities decoded. */
const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]!.replace(/&#x27;/g, "'"));

describe("OwnerListingCard", () => {
  it("titles each row with an h2 under the page's h1, in the title's own direction", () => {
    const html = render(summary("published"));
    expect(html).toMatch(/<h2 [^>]*><a [^>]*dir="auto"[^>]*>Vélo de ville<\/a><\/h2>/);
    expect(html).not.toContain("<h3");
  });

  it("isolates the seller's title inside every translated label", () => {
    const html = render(summary("published", { canRenew: true }));
    expect(labels(html)).toContain(fr.MyListings.actions.menu.replace("{title}", isolate("Vélo de ville")));
    expect(labels(html)).toContain(fr.MyListings.actions.renewOf.replace("{title}", isolate("Vélo de ville")));
    const arabic = render(summary("published", { canRenew: true }), "ar");
    expect(labels(arabic)).toContain(ar.MyListings.actions.menu.replace("{title}", isolate("Vélo de ville")));
  });

  it("names each primary action by its visible label first, in French and Arabic", () => {
    const cases: [ListingStatus, Partial<OwnerListingSummary>, keyof typeof fr.MyListings.actions, keyof typeof fr.MyListings.actions][] = [
      ["draft", {}, "continueDraft", "continueDraftOf"],
      ["rejected", {}, "edit", "editOf"],
      ["paused", {}, "resume", "resumeOf"],
      ["published", { canRenew: true }, "renew", "renewOf"],
      ["expired", { canRenew: true, expiresAt: "2026-10-10T00:00:00.000Z" }, "renew", "renewOf"],
    ];
    for (const locale of ["fr", "ar"] as const) {
      const messages = locale === "ar" ? ar : fr;
      for (const [status, overrides, visible, named] of cases) {
        const html = render(summary(status, overrides), locale);
        const name = messages.MyListings.actions[named].replace("{title}", isolate("Vélo de ville"));
        expect(name.startsWith(messages.MyListings.actions[visible]), `${locale} ${named}`).toBe(true);
        expect(labels(html), `${locale} ${status}`).toContain(name);
        expect(html).toContain(`${messages.MyListings.actions[visible]}</`);
      }
    }
  });

  it("puts the primary action on its own full row on phones, beside the text from sm", () => {
    const html = render(summary("published", { canRenew: true }));
    expect(html).toMatch(/<li class="grid grid-cols-\[7rem_minmax\(0,1fr\)\][^"]*sm:grid-cols-\[9rem_minmax\(0,1fr\)\]/);
    expect(html).toMatch(/<div class="col-span-2 [^"]*sm:col-span-1 sm:col-start-2[^"]*"><button/);
    expect(render(summary("published"))).not.toContain("col-span-2");
  });

  it("gives the missing cover an image role, so its label is announced", () => {
    expect(render(summary("draft"))).toContain(`<span role="img" aria-label="${fr.MyListings.noPhoto}"`);
  });
});
