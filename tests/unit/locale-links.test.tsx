import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import type * as Radix from "radix-ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LocaleMenu from "@/components/layout/locale-menu";
import { LocaleLinks } from "@/components/layout/locale-switcher";
import type { Locale } from "@/config/site";
import { loadMessages } from "@/i18n/messages";

// The language menu and its link fallback keep the query string of the page: search filters,
// ?next= of the challenge page and the unsubscribe token live in the URL. The menu content is
// rendered inline here (Radix mounts it only once open in the browser).

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

const props = { triggerClassName: "trigger", label: "FR, Langue", children: "FR" };

beforeEach(() => {
  nav.pathname = "/fr/recherche";
  nav.search = "";
});

describe.each([
  ["menu", () => <LocaleMenu {...props} />],
  ["link fallback", () => <LocaleLinks {...props} />],
])("language %s", (_name, element) => {
  it("keeps the query string of the page in every language", () => {
    nav.search = "q=velo&ville=rabat&prix-max=2000&etat=neuf&etat=bon";
    expect(hrefs(render(element()))).toEqual(["fr", "ar", "rif"].map((locale) => `/${locale}/recherche?q=velo&ville=rabat&prix-max=2000&etat=neuf&etat=bon`));

    nav.pathname = "/ar/alertes/desabonnement";
    nav.search = "t=abc.def";
    expect(hrefs(render(element(), "ar"))).toEqual(["/fr/alertes/desabonnement?t=abc.def", "/ar/alertes/desabonnement?t=abc.def", "/rif/alertes/desabonnement?t=abc.def"]);
  });

  it("links the bare path when there is no query, with 44 px rows", () => {
    nav.pathname = "/fr";
    const html = render(element());
    expect(hrefs(html)).toEqual(["/fr", "/ar", "/rif"]);
    expect(html.match(/<a [^>]*class="flex min-h-11 /g)).toHaveLength(3);
  });
});
