import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { HomeShortcuts } from "@/components/home/home-shortcuts";
import { loadMessages } from "@/i18n/messages";

// The home page's doors (owner, 30 Oct 2026): the shop directory and the procedures guide on every
// screen, and in the map panel's compact tiles the two rental searches first, phones only.

const ar = await loadMessages("ar");

function render(node: ReactNode, locale: "fr" | "ar" = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("HomeShortcuts", () => {
  it("opens the directory and the guide from the list view, titled and explained from sm", () => {
    const html = render(<HomeShortcuts />);
    expect(html).toContain(`<nav aria-label="${fr.Home.shortcuts.label}" data-testid="home-shortcuts"`);
    expect(html).toMatch(/<a data-testid="home-shops" class="[^"]*" href="\/fr\/boutiques">/);
    expect(html).toMatch(/<a data-testid="home-guide" class="[^"]*" href="\/fr\/demarches">/);
    expect(html).toContain(`<span>${fr.Home.shortcuts.shops}</span><span class="text-xs font-normal text-foreground-muted max-sm:hidden">${fr.Home.shortcuts.shopsHint}</span>`);
    expect(html).toContain(fr.Home.shortcuts.guideHint);
    // No rental tile here: the list view has its car rental module.
    expect(html).not.toContain("location-voitures");
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  it("puts the two rental searches first in the compact map panel, phones only, without hints", () => {
    const html = render(<HomeShortcuts compact />);
    const links = html.match(/<a [^>]*>/g) ?? [];
    expect(links).toHaveLength(4);
    expect(links[0]).toContain("md:hidden");
    expect(links[0]).toContain("sous-categorie=location-voitures");
    expect(links[1]).toContain("md:hidden");
    expect(links[1]).toContain("sous-categorie=location-vacances");
    expect(links[2]).toContain('href="/fr/boutiques"');
    expect(links[2]).not.toContain("md:hidden");
    expect(links[3]).toContain('href="/fr/demarches"');
    expect(html).not.toContain(fr.Home.shortcuts.shopsHint);
    expect(html).toContain(fr.Rental.home.title);
    expect(html).toContain(fr.Categories.immobilier.sub["location-vacances"]);
  });

  it("speaks Arabic", () => {
    const html = render(<HomeShortcuts />, "ar");
    expect(html).toContain(`aria-label="${ar.Home.shortcuts.label}"`);
    expect(html).toContain(ar.Home.shortcuts.shops);
    expect(html).toContain('href="/ar/demarches"');
  });
});
