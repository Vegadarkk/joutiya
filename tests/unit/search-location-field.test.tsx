import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import type * as Radix from "radix-ui";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { CategoryGrid } from "@/components/home/category-grid";
import { HeaderSearch } from "@/components/layout/header-search";
import { SwitchField } from "@/components/post/controls/switch";
import { SearchCityCombobox } from "@/components/search/city-combobox";
import { dropEmptyFields } from "@/components/search/drop-empty-fields";
import { escapeClosesList, FiltersSheet } from "@/components/search/filters-sheet";
import type { Locale } from "@/config/site";
import { parseSearchParams } from "@/lib/search/params";

// Place field, filters sheet, switch rows and search forms after the phase 4 browser pass: the list
// floats above the results toolbar and stays out of the Tab order, Escape in an open list keeps
// the sheet, the sheet animates out, switch rows are 44 px targets, the GET search forms leave
// empty fields out of the URL and the category row shows part of the next tile.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/recherche",
}));
// The sheet renders open and in place: the server render has no portal and no click.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof Radix>();
  return {
    ...actual,
    Dialog: {
      ...actual.Dialog,
      Root: (props: ComponentProps<typeof actual.Dialog.Root>) => createElement(actual.Dialog.Root, { ...props, open: true }),
      Portal: ({ children }: { children?: ReactNode }) => children,
    },
  };
});

function render(node: ReactNode, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

const classOf = (html: string, pattern: RegExp) => html.match(pattern)?.[1]?.split(" ") ?? [];

describe("SearchCityCombobox list", () => {
  it("floats above the sticky results toolbar (z-30) and under the header (z-40)", () => {
    const html = render(<SearchCityCombobox value={{}} onChange={() => undefined} label="Lieu" />);
    const list = classOf(html, /role="listbox"[^>]*class="([^"]*)"/);
    expect(list).toContain("absolute");
    expect(list).toContain("z-35");
  });

  it("stays out of the Tab order, inline too", () => {
    const floating = render(<SearchCityCombobox value={{}} onChange={() => undefined} label="Lieu" />);
    const inline = render(<SearchCityCombobox value={{ city: "rabat" }} onChange={() => undefined} label="Lieu" inline />, "ar");
    for (const html of [floating, inline]) expect(html).toMatch(/role="listbox"[^>]*tabindex="-1"/);
    expect(classOf(inline, /role="listbox"[^>]*class="([^"]*)"/).some((name) => name.startsWith("z-"))).toBe(false);
  });
});

describe("FiltersSheet", () => {
  const params = parseSearchParams(new URLSearchParams("ville=casablanca&prix_min=100"));

  it("lets Escape close an open place list only", () => {
    const field = (attributes: Record<string, string>) => ({ getAttribute: (name: string) => attributes[name] ?? null }) as unknown as EventTarget;
    expect(escapeClosesList(field({ role: "combobox", "aria-expanded": "true" }))).toBe(true);
    expect(escapeClosesList(field({ role: "combobox", "aria-expanded": "false" }))).toBe(false);
    expect(escapeClosesList(field({ role: "textbox" }))).toBe(false);
    expect(escapeClosesList(null)).toBe(false);
    expect(escapeClosesList({} as EventTarget)).toBe(false);
  });

  it("animates out the way it came in, in both directions", () => {
    for (const locale of ["fr", "ar"] as const) {
      const html = render(<FiltersSheet params={params} />, locale);
      const content = classOf(html, /data-testid="filters-sheet"[^>]*class="([^"]*)"/);
      expect(content).toEqual(expect.arrayContaining(["data-[state=closed]:animate-out", "data-[state=closed]:fade-out-0", "data-[state=closed]:slide-out-to-bottom"]));
      expect(content).toEqual(expect.arrayContaining(["ltr:sm:data-[state=closed]:slide-out-to-right", "rtl:sm:data-[state=closed]:slide-out-to-left", "sm:data-[state=closed]:[--tw-exit-translate-y:0]"]));
      expect(html).toMatch(/class="fixed inset-0 z-50[^"]*data-\[state=closed\]:animate-out[^"]*data-\[state=closed\]:fade-out-0/);
      expect(html).toContain((locale === "ar" ? ar : fr).SearchFilters.withPhoto);
    }
  });
});

describe("SwitchField", () => {
  it("makes the whole row a 44 px target without touching the switch", () => {
    for (const className of [undefined, "py-0"]) {
      const html = render(<SwitchField label="Avec photos uniquement" checked={false} onCheckedChange={() => undefined} className={className} />);
      expect(html).toMatch(/^<div class="relative flex/);
      const label = classOf(html, /<label[^>]*class="([^"]*)"/);
      expect(label).toEqual(expect.arrayContaining(["after:absolute", "after:inset-x-0", "after:h-full", "after:min-h-11", "after:top-1/2", "after:-translate-y-1/2"]));
      expect(html).toMatch(/role="switch"[^>]*class="relative mt-0\.5 inline-flex h-7 w-12/);
    }
  });
});

describe("header search pill", () => {
  it("leaves empty fields out of the submitted URL", () => {
    const data = new FormData();
    data.append("q", "");
    data.append("ville", "marrakech");
    dropEmptyFields(data);
    expect(new URLSearchParams(data as unknown as Record<string, string>).toString()).toBe("ville=marrakech");

    const words = new FormData();
    words.append("q", "vélo");
    words.append("region", "  ");
    dropEmptyFields(words);
    expect([...words.entries()]).toEqual([["q", "vélo"]]);
  });

  it("renders the GET form to the search page: words, then the place under its own name, then a named submit", () => {
    const html = render(<HeaderSearch locale="ar" />, "ar");
    const form = /<form [^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toContain(`role="search" aria-label="${ar.Nav.searchLabel}"`);
    expect(form).toContain('action="/ar/recherche" method="get"');
    expect(html).toContain('name="q"');
    // The place keeps the search page's names (ville / region) and has a label of its own: the
    // posting wizard's "Ville" field shares no accessible name with it.
    expect(html).toContain(`<label for="${/<label for="([^"]+-input)"/.exec(html)?.[1]}" class="sr-only">${ar.Nav.searchPlace}</label>`);
    expect(fr.Nav.searchPlace).not.toMatch(/ville/i);
    expect(html).toContain(`aria-label="${ar.Nav.searchSubmit}"`);
    // The place segment from xl only: phones, tablets and lg laptops search by words.
    expect(html).toMatch(/<div class="relative hidden w-48 [^"]*xl:block[^"]*"><div class="relative flex flex-col/);
  });
});

describe("CategoryGrid", () => {
  it("sizes the tiles on the row width below xl, so part of the next tile shows", () => {
    const html = render(<CategoryGrid />);
    const tile = classOf(html, /<li[^>]*class="([^"]*)"/);
    expect(tile).toContain("w-[max(5.75rem,calc((100%_-_0.75rem)/3.5))]");
    expect(tile).toContain("sm:w-[max(5.75rem,calc((100%_-_1.5rem)/6.5))]");
    expect(tile).toContain("xl:w-auto");
    expect(classOf(html, /<ul[^>]*class="([^"]*)"/)).toEqual(expect.arrayContaining(["scroll-px-4", "sm:scroll-px-6"]));
  });
});
