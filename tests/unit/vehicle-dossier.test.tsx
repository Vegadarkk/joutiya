import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { CriteriaGrid } from "@/components/listing/criteria-grid";
import { VehicleBuyingGuide } from "@/components/listing/vehicle-buying-guide";
import { VehicleDossier } from "@/components/listing/vehicle-dossier";
import { SITE_NAME, type Locale } from "@/config/site";

// Concession pack, listing page (design concession/concession.md §2): the vehicle dossier section and
// the Moroccan buying guide.

function render(node: ReactNode, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const CAR = { "car-brand": "dacia", model: "Duster", year: 2022, mileage: 41000, fuel: "diesel", gearbox: "manuelle" };
const DOSSIER = {
  "first-hand": true,
  "service-history": "complet",
  "vehicle-papers": ["carte-grise", "libre-de-gage"],
  "vehicle-warranty": "constructeur",
  "warranty-months": 24,
  "trade-in": true,
  financing: true,
  "car-equipment": ["gps", "camera-recul"],
  "stock-ref": "DUS-041",
};

describe("VehicleDossier", () => {
  it("shows nothing without a dossier field", () => {
    expect(render(<VehicleDossier subcategoryId="voitures" attributes={CAR} />)).toBe("");
    // Not a vehicle for sale: no dossier even if attributes happen to carry the keys.
    expect(render(<VehicleDossier subcategoryId="velos" attributes={{ "trade-in": true }} />)).toBe("");
  });

  it("shows the highlights, papers, equipment and stock reference the seller declared", () => {
    const html = render(<VehicleDossier subcategoryId="voitures" attributes={{ ...CAR, ...DOSSIER }} />);
    const shown = text(html);
    expect(shown).toContain(fr.ListingPage.dossier.title);
    expect(shown).toContain(`${fr.Criteria["vehicle-warranty"].options.constructeur} 24 mois`);
    expect(shown).toContain(fr.ListingPage.dossier.tradeIn);
    expect(shown).toContain(fr.ListingPage.dossier.financing);
    expect(shown).toContain(fr.Criteria["service-history"].options.complet);
    expect(shown).toContain(fr.Criteria["first-hand"].label);
    expect(shown).toContain(fr.Criteria["vehicle-papers"].options["libre-de-gage"]);
    expect(shown).toContain(fr.Criteria["car-equipment"].options["camera-recul"]);
    expect(shown).toContain("DUS-041");
    expect(shown).toContain(fr.ListingPage.dossier.declared);
    // Without warranty or with no service history, no highlight claims one.
    const bare = text(render(<VehicleDossier subcategoryId="voitures" attributes={{ ...CAR, "vehicle-warranty": "aucune", "service-history": "aucun", "trade-in": false }} />));
    expect(bare).toBe("");
  });

  it("keeps the dossier out of the main criteria grid", () => {
    const shown = text(render(<CriteriaGrid subcategoryId="voitures" condition={null} attributes={{ ...CAR, ...DOSSIER }} />));
    expect(shown).not.toContain(fr.Criteria["vehicle-warranty"].label);
    expect(shown).not.toContain("DUS-041");
    expect(text(render(<CriteriaGrid subcategoryId="voitures" group="dossier" condition={null} attributes={{ ...CAR, ...DOSSIER }} />))).toContain("DUS-041");
  });

  it("speaks Arabic", () => {
    const shown = text(render(<VehicleDossier subcategoryId="voitures" attributes={{ ...CAR, ...DOSSIER }} />, "ar"));
    expect(shown).toContain(ar.ListingPage.dossier.title);
    expect(shown).toContain(ar.ListingPage.dossier.tradeIn);
  });
});

describe("VehicleBuyingGuide", () => {
  it("lists the Moroccan steps and the neutral-host statement with the brand", () => {
    const shown = text(render(<VehicleBuyingGuide attributes={CAR} sellerType="individual" />));
    expect(shown).toContain(fr.ListingPage.buyingGuide.title);
    expect(shown).toContain("NARSA");
    expect(shown).toContain(`${SITE_NAME} ne vend pas ce véhicule`);
    expect(shown).not.toContain(fr.ListingPage.buyingGuide.notes.financing);
    expect(shown).not.toContain(fr.ListingPage.buyingGuide.customs);
  });

  it("adds the customs warning, the credit note and a Pro's written warranty when they apply", () => {
    const shown = text(render(<VehicleBuyingGuide attributes={{ ...CAR, origin: "pas-dedouanee", financing: true, "vehicle-warranty": "vendeur" }} sellerType="pro" />));
    expect(shown).toContain(fr.ListingPage.buyingGuide.customs);
    expect(shown).toContain(fr.ListingPage.buyingGuide.notes.financing);
    expect(shown).toContain(fr.ListingPage.buyingGuide.notes.warranty);
    // An individual's own warranty is not a Pro's conventional warranty (loi 31-08).
    expect(text(render(<VehicleBuyingGuide attributes={{ ...CAR, "vehicle-warranty": "vendeur" }} sellerType="individual" />))).not.toContain(fr.ListingPage.buyingGuide.notes.warranty);
  });

  it("speaks Arabic", () => {
    expect(text(render(<VehicleBuyingGuide attributes={CAR} sellerType="individual" />, "ar"))).toContain(ar.ListingPage.buyingGuide.title);
  });
});
