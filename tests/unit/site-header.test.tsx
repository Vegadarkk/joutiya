import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { AccountMenu } from "@/components/auth/account-menu";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { showsCategoryRow, showsSellButton } from "@/components/layout/shell-paths";
import { SiteHeader } from "@/components/layout/site-header";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { CATEGORIES } from "@/config/categories";
import type { Locale } from "@/config/site";
import { loadMessages } from "@/i18n/messages";
import { InitialSessionContext } from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";

// Header controls (server markup): accessible names that hold the visible text (WCAG 2.5.3), a
// named search landmark, 44 px touch targets, the category row and the phone's "Vendre" arch.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  usePathname: () => "/fr/mes-annonces",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

// Arabic over the French base, as the app loads it (the language codes are only in fr.json).
const ar = await loadMessages("ar");

function render(node: ReactNode, locale: Locale = "fr", session: SessionSummary | null = null) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      <InitialSessionContext.Provider value={session}>{node}</InitialSessionContext.Provider>
    </NextIntlClientProvider>,
  );
}

const session: SessionSummary = {
  uid: "uid-1",
  email: "salma@test.joutiya.ma",
  emailVerified: true,
  role: "individual",
  suspended: false,
  displayName: "Salma Benali",
  publicId: "abcdefghjk",
  phoneVerified: false,
  locale: "fr",
  providers: ["password"],
  cguUpdate: null,
};

describe("LocaleSwitcher", () => {
  it("starts its accessible name with the visible language code", () => {
    expect(render(<LocaleSwitcher />)).toContain('aria-label="FR, Langue"');
    const arabic = render(<LocaleSwitcher />, "ar");
    expect(arabic).toContain(`aria-label="${ar.Locale.short.ar}، ${ar.Locale.label}"`);
    expect(arabic).toContain(`<span>${ar.Locale.short.ar}</span>`);
  });
});

describe("AccountMenu", () => {
  it("names the signed-in trigger by its text, 'Mon compte', behind a decorative avatar", () => {
    const html = render(<AccountMenu />, "fr", session);
    const trigger = /<button[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(trigger?.[0]).not.toContain("aria-label=");
    expect(trigger?.[1]).toMatch(new RegExp(`^<span class="[^"]*" aria-hidden="true">SB</span><span class="sr-only">${fr.Auth.menu.account}</span>$`));
    expect(trigger?.[0]).toContain("min-w-11");
    expect(trigger?.[0]).toContain("rounded-full");
    // Messages (members) and favourites sit beside it in the header pill.
    expect(html).toContain(`aria-label="${fr.Auth.menu.messagesLink}"`);
    expect(html).toMatch(new RegExp(`<a aria-label="${fr.Auth.menu.favorites}" class="[^"]*hidden md:inline-flex[^"]*" href="/fr/favoris"`));
  });

  it("gives the anonymous sign-in link a 44 px target from lg, named by its text from xl, and phones a visitor menu", () => {
    const html = render(<AccountMenu />);
    expect(html).toMatch(/<a class="[^"]*min-w-11[^"]*hidden lg:inline-flex[^"]*" href="\/fr\/connexion\?next=/);
    expect(html).toContain(`<span class="hidden xl:inline">${fr.Nav.signIn}</span><span class="sr-only xl:hidden">${fr.Nav.signIn}</span>`);
    expect(html).toContain('href="/fr/favoris"');
    expect(html).not.toContain(`aria-label="${fr.Auth.menu.messagesLink}"`);
    // Below lg: the visitor menu (sign in, create an account, the rentals, the Pro space), a plain 44 px button until its chunk runs.
    const menu = /<button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="([^"]+)" data-testid="visitor-menu" class="([^"]*)"/.exec(html);
    expect(menu?.[1]).toBe(fr.Nav.visitorMenu);
    expect(menu?.[2]).toContain("min-w-11");
    expect(menu?.[2]).toContain("lg:hidden");
  });
});

describe("SiteHeader", () => {
  it("names its search landmark and keeps the logo link 44 px or more", () => {
    const html = render(<SiteHeader locale="fr" />);
    expect(html).toContain(`role="search" aria-label="${fr.Nav.searchLabel}"`);
    expect(html).toMatch(/<a aria-label="Accueil Aalan" class="flex size-12 [^"]*md:h-13[^"]*" href="\/fr"/);
    expect(html).toContain(`placeholder="${fr.Nav.searchPlaceholder}"`);
    expect(html).toContain('data-testid="header-actions"');
  });

  it("hides its search pill when the main content has its own search form (/recherche, help centre)", () => {
    const html = render(<SiteHeader locale="ar" />, "ar");
    const form = /<form [^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toContain('action="/ar/recherche"');
    expect(form).toContain("[:root:has(#main_[role=search])_&amp;]:hidden");
  });

  it("names the 'Vendre' arch by its visible text, then what it does", () => {
    const html = render(<SiteHeader locale="fr" />);
    const sell = /<a class="sell-arch [^"]*" href="\/fr\/deposer">([\s\S]*?)<\/a>/.exec(html);
    expect(sell?.[0]).toContain("h-13");
    expect(sell?.[1]).toContain(`${fr.Nav.sell}<span class="sr-only">, ${fr.Nav.post}</span>`);
  });

  it("lists the category pages and the procedures guide in a named row", () => {
    const html = render(<SiteHeader locale="fr" />);
    const row = /<nav aria-label="([^"]+)" data-testid="category-chips">([\s\S]*?)<\/nav>/.exec(html);
    expect(row?.[1]).toBe(fr.Nav.categories);
    for (const category of CATEGORIES) expect(row?.[2]).toContain(`href="/fr/c/${category.id}"`);
    expect(row?.[2]).toContain('href="/fr/demarches"');
    expect(row?.[2]).toContain(fr.Nav.guide);
    expect(row?.[2]?.match(/class="group flex h-11 /g)).toHaveLength(CATEGORIES.length + 1);
  });

  it("stands 'Louer' (the car and the house, a menu) and 'Espace Pro' beside 'Vendre' from lg, compact until xl", () => {
    const html = render(<SiteHeader locale="fr" />);
    const rent = /<button type="button" aria-haspopup="menu" aria-expanded="false" data-testid="header-rent" class="([^"]*)">([\s\S]*?)<\/button>/.exec(html);
    expect(rent?.[1]).toContain("hidden");
    expect(rent?.[1]).toContain("lg:inline-flex");
    expect(rent?.[1]).toContain("h-13");
    expect(rent?.[2]).toContain("lucide-car-front");
    expect(rent?.[2]).toContain("lucide-house");
    expect(rent?.[2]).toContain(`<span class="hidden xl:inline">${fr.Nav.rent}</span><span class="sr-only xl:hidden">${fr.Nav.rent}</span>`);
    const pro = /<a data-testid="header-pro" class="([^"]*)" href="([^"]+)">([\s\S]*?)<\/a>/.exec(html);
    expect(pro?.[2]).toBe("/fr/professionnels");
    expect(pro?.[1]).toContain("lg:inline-flex");
    expect(pro?.[3]).toContain(`<span class="hidden xl:inline">${fr.Nav.proSpace}</span><span class="xl:hidden">${fr.Nav.proShort}</span>`);
    // The order of the right group: the account pill, "Louer", "Espace Pro", then the arch.
    expect(html.indexOf('data-testid="header-actions"')).toBeLessThan(html.indexOf('data-testid="header-rent"'));
    expect(html.indexOf('data-testid="header-rent"')).toBeLessThan(html.indexOf('data-testid="header-pro"'));
    expect(html.indexOf('data-testid="header-pro"')).toBeLessThan(html.indexOf('href="/fr/deposer"'));
  });

  it("sends a Pro straight to their space from 'Espace Pro'", () => {
    const html = render(<SiteHeader locale="fr" />, "fr", { ...session, role: "pro" });
    expect(html).toMatch(/<a data-testid="header-pro" class="[^"]*" href="\/fr\/pro">/);
    // Arabic: the same pieces, the labels translated.
    const arabic = render(<SiteHeader locale="ar" />, "ar");
    expect(arabic).toContain(`<span class="hidden xl:inline">${ar.Nav.rent}</span>`);
    expect(arabic).toContain(`<span class="hidden xl:inline">${ar.Nav.proSpace}</span>`);
  });

  it("floats 'Vendre' on phones, out of the cookie banner's way", () => {
    const html = render(<SiteHeader locale="fr" />);
    const fab = /<a aria-label="([^"]+)" data-sell-fab="" class="(sell-arch fixed [^"]*)" href="\/fr\/deposer"/.exec(html);
    expect(fab?.[1]).toBe(fr.Nav.post);
    expect(fab?.[2]).toContain("md:hidden");
    expect(fab?.[2]).toContain("env(safe-area-inset-bottom)");
    expect(fab?.[2]).toContain("[:root:has([data-testid=consent-banner])_&amp;]:hidden");
    // Out of the way of a field being filled, too (UX audit, 13); the footer keeps a lane for it.
    expect(fab?.[2]).toContain("[:root:has(main_:is(input,select,textarea):focus)_&amp;]:hidden");
  });
});

describe("shell paths", () => {
  it("drops the category row in the focused flows and 'Vendre' over forms and bottom bars", () => {
    for (const path of ["/c/vehicules", "/mes-annonces", "/demarches"]) {
      expect(showsCategoryRow(path), path).toBe(true);
      expect(showsSellButton(path), path).toBe(true);
    }
    // The home page (lot 3) shows the twelve categories itself (map panel or arcade); 'Vendre' stays.
    expect(showsCategoryRow("/")).toBe(false);
    expect(showsSellButton("/")).toBe(true);
    expect(showsCategoryRow("/c")).toBe(true);
    // The map-first search (lot 2) keeps 'Vendre' over its sheet; its filters replace the category row.
    expect(showsCategoryRow("/recherche")).toBe(false);
    expect(showsSellButton("/recherche")).toBe(true);
    expect(showsCategoryRow("/recherches")).toBe(true);
    for (const path of ["/deposer", "/deposer/abc/photos", "/connexion", "/messages", "/messages/c1", "/anti-robot"]) {
      expect(showsCategoryRow(path), path).toBe(false);
      expect(showsSellButton(path), path).toBe(false);
    }
    for (const path of ["/annonce/velo-abc", "/pro/flotte"]) {
      expect(showsCategoryRow(path), path).toBe(true);
      expect(showsSellButton(path), path).toBe(false);
    }
    expect(showsSellButton("/deposerx")).toBe(true);
  });
});

describe("ThemeToggle", () => {
  it("offers three 44 px radios", () => {
    const html = render(<ThemeToggle />);
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html.match(/inline-flex size-11 /g)).toHaveLength(3);
  });
});
