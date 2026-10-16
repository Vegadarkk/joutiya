import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { SearchNavigationProvider } from "@/components/search/search-navigation";
import { SortSelect } from "@/components/search/sort-select";
import { parseSearchParams } from "@/lib/search/params";

// The sort select shows the sort just picked while its results load, not the previous one: its
// value is React's optimistic state over the page's sort. No DOM here: the optimistic value is
// seeded the way React holds it during the navigation transition.

const seed = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  const useOptimistic = ((passthrough: unknown) => {
    const [value, set] = actual.useOptimistic(passthrough);
    return [seed.value ?? value, set];
  }) as typeof actual.useOptimistic;
  return { ...actual, useOptimistic, default: { ...actual, useOptimistic } };
});
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/recherche",
}));

const render = (query: string) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      <SearchNavigationProvider>
        <SortSelect params={parseSearchParams(new URLSearchParams(query))} />
      </SearchNavigationProvider>
    </NextIntlClientProvider>,
  );

const selected = (html: string) => /<option value="([a-z_]+)" selected="">/.exec(html)?.[1];

beforeEach(() => {
  seed.value = undefined;
});

describe("SortSelect while the new results load", () => {
  it("shows the page's sort when nothing is pending", () => {
    expect(selected(render("q=velo"))).toBe("relevance");
    expect(selected(render("q=velo&tri=prix-croissant"))).toBe("price_asc");
  });

  it("shows the sort just picked, not the one of the results still on screen", () => {
    seed.value = "price_desc";
    expect(selected(render("q=velo"))).toBe("price_desc");
  });
});
