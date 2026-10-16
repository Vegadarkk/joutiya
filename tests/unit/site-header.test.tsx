import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import type * as Radix from "radix-ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { SiteHeader } from "@/components/layout/site-header";
import type { Locale } from "@/config/site";
import { loadMessages } from "@/i18n/messages";

// Header fixes: 44 px touch targets (logo link, every control on the end side), no header search
// on pages that carry their own search form, and a language switch that keeps the query string
// (search filters, ?next= of the challenge page, unsubscribe token). The menu content is rendered
// inline here (Radix mounts it only once opened in the browser).

const nav = vi.hoisted(() => ({ pathname: "/fr/recherche", search: "" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof Radix>();
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Trigger = ({ children, className }: { children?: ReactNode; className?: string }) => (
    <button type="button" className={className}>
      {children}
    </button>
  );
  return { ...actual, DropdownMenu: { ...actual.DropdownMenu, Root: Pass, Trigger, Portal: Pass, Content: Pass, Item: Pass } };
});

const MESSAGES = { fr: await loadMessages("fr"), ar: await loadMessages("ar"), rif: await loadMessages("rif") };

function render(node: ReactNode, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

/** The href of each language link (the tags that carry a lang attribute). */
const hrefs = (html: string) =>
  [...html.matchAll(/<a [^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => / lang="/.test(tag))
    .map((tag) => / href="([^"]+)"/.exec(tag)?.[1]?.replace(/&amp;/g, "&"));

beforeEach(() => {
  nav.pathname = "/fr/recherche";
  nav.search = "";
});

describe("LocaleSwitcher", () => {
  it("keeps the query string of the page in every language", () => {
    nav.search = "q=velo&ville=rabat&prix-max=2000&etat=neuf&etat=bon";
    expect(hrefs(render(<LocaleSwitcher />))).toEqual(["fr", "ar", "rif"].map((locale) => `/${locale}/recherche?q=velo&ville=rabat&prix-max=2000&etat=neuf&etat=bon`));

    nav.pathname = "/ar/alertes/desabonnement";
    nav.search = "t=abc.def";
    expect(hrefs(render(<LocaleSwitcher />, "ar"))).toEqual(["/fr/alertes/desabonnement?t=abc.def", "/ar/alertes/desabonnement?t=abc.def", "/rif/alertes/desabonnement?t=abc.def"]);
  });

  it("links the bare path when there is no query", () => {
    nav.pathname = "/fr";
    expect(hrefs(render(<LocaleSwitcher />))).toEqual(["/fr", "/ar", "/rif"]);
  });

  it("gives every language a 44 px row", () => {
    expect(render(<LocaleSwitcher />).match(/<a [^>]*class="flex min-h-11 /g)).toHaveLength(3);
  });
});

describe("SiteHeader", () => {
  it("makes the logo link and the end-side controls 44 px touch targets", () => {
    const html = render(<SiteHeader locale="fr" />);
    expect(html).toMatch(/<a [^>]*class="h-11 [^"]*py-0\.5 md:h-12 md:py-0"[^>]*aria-label="[^"]+"/);
    expect(html).toContain('<div class="ms-auto flex items-center gap-1 *:min-w-11">');
  });

  it("hides its search field when the main content has its own search form", () => {
    nav.pathname = "/ar";
    const html = render(<SiteHeader locale="ar" />, "ar");
    const form = /<form [^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toContain('action="/ar/recherche"');
    expect(form).toContain("[:root:has(#main_[role=search])_&amp;]:hidden");
  });
});
