import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { AccountMenu } from "@/components/auth/account-menu";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { SiteHeader } from "@/components/layout/site-header";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import type { Locale } from "@/config/site";
import { loadMessages } from "@/i18n/messages";
import { InitialSessionContext } from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";

// Header controls (server markup): accessible names that hold the visible text (WCAG 2.5.3), a
// named search landmark, and 44 px touch targets.

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
  it("names the signed-in trigger by its text: 'Mon compte', then the display name shown from sm", () => {
    const html = render(<AccountMenu />, "fr", session);
    const trigger = /<button[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(trigger?.[0]).not.toContain("aria-label=");
    expect(trigger?.[1]).toContain(`<span class="sr-only">${fr.Auth.menu.account}</span> <span dir="auto" class="hidden max-w-32 truncate sm:inline">Salma Benali</span>`);
    // The initials are a decorative avatar.
    expect(trigger?.[1]).toMatch(/<span class="[^"]*" aria-hidden="true">SB<\/span>/);
    expect(trigger?.[0]).toContain("min-w-11");
  });

  it("gives the anonymous sign-in link a 44 px target", () => {
    const html = render(<AccountMenu />);
    expect(html).toMatch(/<a [^>]*class="[^"]*min-w-11[^"]*"[^>]*href="\/fr\/connexion\?next=/);
    expect(html).toContain(`<span class="sr-only sm:hidden">${fr.Nav.signIn}</span>`);
  });
});

describe("SiteHeader", () => {
  it("names its search landmark (the home page has a second one) and keeps the logo link 44 px tall", () => {
    const html = render(<SiteHeader locale="fr" />);
    expect(html).toContain(`role="search" aria-label="${fr.Nav.searchLabel}"`);
    expect(html).toMatch(/<a class="flex h-11 [^"]*" aria-label="Accueil Joutiya" href="\/fr"/);
  });
});

describe("ThemeToggle", () => {
  it("offers three 44 px radios", () => {
    const html = render(<ThemeToggle />);
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html.match(/inline-flex size-11 /g)).toHaveLength(3);
  });
});
