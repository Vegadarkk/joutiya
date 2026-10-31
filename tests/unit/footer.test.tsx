import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { Footer } from "@/components/legal/footer";

// Client widgets with their own tests.
vi.mock("@/components/layout/theme-toggle", () => ({
  ThemeToggle: () => null,
}));
vi.mock("@/components/layout/locale-switcher", () => ({
  LocaleSwitcher: () => null,
}));
vi.mock("@/components/consent/consent-link", () => ({
  ConsentLink: () => null,
}));

// Leboncoin's footer layout (owner, 2026-10-31): the plan of the categories and of the regions, then four columns.

const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="fr"
      messages={fr}
      timeZone="Africa/Casablanca"
    >
      <Footer publisher="Adark Prime" />
    </NextIntlClientProvider>,
  );

describe("Footer", () => {
  it("lists every category with its subcategories, and the regions with their main cities", () => {
    const html = render();
    expect(html).toContain(`aria-label="${fr.Footer.categoriesLabel}"`);
    expect(html).toMatch(/href="\/fr\/c\/vehicules"/);
    expect(html).toMatch(/href="\/fr\/recherche\?[^"]*location-vacances"/);
    expect(html).toContain(`aria-label="${fr.Footer.regionsLabel}"`);
    expect(html).toContain(">Casablanca</a>");
    expect(html).toContain(">Nador</a>");
  });

  it("keeps the legal, Pro and help columns", () => {
    const html = render();
    for (const label of [
      fr.Footer.legalTitle,
      fr.Footer.prosTitle,
      fr.Footer.questionsTitle,
      fr.Footer.contact,
      fr.Footer.links.mentions,
      fr.Footer.pricing,
      fr.Footer.wallet,
    ])
      expect(html).toContain(label);
    expect(html.match(/Mentions légales/g)).toHaveLength(1);
  });
});
