import type { ReactNode } from "react";
import type * as NextNavigation from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { SaveSearchButton } from "@/components/saved-searches/save-search-button";
import { SavedSearchesView, formatDay, withBusy } from "@/components/saved-searches/saved-searches-view";
import { suggestSearchName, useSearchSummary } from "@/components/saved-searches/summary";
import type { Locale } from "@/config/site";
import type { SearchParams } from "@/lib/search/params";

// Saved searches islands (D18): no button for a blank search, the summary chips and proposed name
// built from the search page's own filter labels, the account page's first state.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/recherche",
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

function Summary({ params }: { params: SearchParams }) {
  const { summarize, suggest } = useSearchSummary();
  return <output data-name={suggest(params)}>{summarize(params).join(" | ")}</output>;
}

describe("SaveSearchButton", () => {
  it("renders nothing for a blank search, sort and page included", () => {
    expect(render(<SaveSearchButton params={{}} />)).toBe("");
    expect(render(<SaveSearchButton params={{ sort: "price_asc", page: 2 }} />)).toBe("");
  });

  it("offers to save any narrowed search", () => {
    const html = render(<SaveSearchButton params={{ q: "vélo" }} />);
    expect(text(html)).toBe(fr.SavedSearches.button.save);
    expect(html).toContain('data-testid="save-search-button"');
    expect(text(render(<SaveSearchButton params={{ subcategory: "velos", category: "vehicules" }} />, "ar"))).toBe(ar.SavedSearches.button.save);
  });

  it("offers an alert of the map zone when the search has one", () => {
    const zone = { lat: 33.6, lng: -7.62, km: 3 };
    expect(text(render(<SaveSearchButton params={{ zone }} />))).toBe("M'alerter des nouvelles annonces ici");
    expect(text(render(<SaveSearchButton params={{ zone }} />, "ar"))).toBe(ar.SavedSearches.button.saveZone);
  });
});

describe("search summary", () => {
  it("lists the words, then the filters with the search page labels", () => {
    const html = render(<Summary params={{ q: "vélo électrique", category: "vehicules", subcategory: "velos", city: "casablanca", priceMax: 3000 }} />);
    const parts = text(html).split(" | ");
    expect(parts[0]).toBe("« vélo électrique »");
    expect(parts.some((part) => part.includes("Casablanca"))).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/data-name="vélo électrique, [^"]+"/);
    const arabic = text(render(<Summary params={{ city: "casablanca" }} />, "ar"));
    expect(arabic).toContain("الدار البيضاء");
  });

  it("names a map zone by its radius around the nearest city, never by coordinates", () => {
    const html = render(<Summary params={{ subcategory: "velos", category: "vehicules", zone: { lat: 34.02, lng: -6.84, km: 12 } }} />);
    expect(text(html)).toContain("Zone de la carte · 12 km autour de Rabat");
    expect(html).toContain('data-name="Vélos, Zone de la carte · 12 km autour de Rabat"');
    expect(html).not.toContain("34.02");
    expect(text(render(<Summary params={{ zone: { lat: 34.02, lng: -6.84, km: 12 } }} />, "ar"))).toContain("منطقة الخريطة · 12 كلم حول الرباط");
  });

  it("proposes a name that fits 60 characters, else the fallback", () => {
    expect(suggestSearchName(["Vélos", "Casablanca", "Moins de 3 000 DH", "Neuf"], ", ", "Ma recherche")).toBe("Vélos, Casablanca, Moins de 3 000 DH");
    expect(suggestSearchName(["x".repeat(70)], ", ", "Ma recherche")).toBe("x".repeat(60));
    expect(suggestSearchName(["a".repeat(40), "b".repeat(30)], ", ", "Ma recherche")).toBe("a".repeat(40));
    expect(suggestSearchName([], ", ", "Ma recherche")).toBe("Ma recherche");
  });
});

describe("SavedSearchesView", () => {
  it("starts on its loading state", () => {
    expect(render(<SavedSearchesView />)).toContain('aria-busy="true"');
  });

  it("formats a day as day and month", () => {
    expect(formatDay("2026-10-12T12:00:00.000Z", "fr")).toBe("12 octobre");
  });

  it("locks each search on its own: a request ending never unlocks another one in flight", () => {
    const a = withBusy(new Set(), "a", true);
    const both = withBusy(a, "b", true);
    const bOnly = withBusy(both, "a", false);
    expect([...a]).toEqual(["a"]);
    expect(bOnly.has("b")).toBe(true);
    expect(bOnly.has("a")).toBe(false);
    expect(both.has("a")).toBe(true);
  });

  it("names each row action with its visible label first (WCAG 2.5.3), in fr and ar", () => {
    for (const [locale, messages] of [["fr", fr], ["ar", ar]] as const) {
      const t = createTranslator({ locale, messages, namespace: "SavedSearches.page" });
      expect(t("openOf", { name: "Vélos" }).startsWith(t("open"))).toBe(true);
      expect(t("renameOf", { name: "Vélos" }).startsWith(t("rename"))).toBe(true);
      expect(t("deleteOf", { name: "Vélos" }).startsWith(t("delete"))).toBe(true);
    }
  });
});
