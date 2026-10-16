import type { ReactNode } from "react";
import type * as NextNavigation from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { SaveSearchButton } from "@/components/saved-searches/save-search-button";
import { SavedSearchesView, formatDay } from "@/components/saved-searches/saved-searches-view";
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
});
