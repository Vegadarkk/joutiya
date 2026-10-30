import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { GuideSearch, matchGuideEntries, type GuideSearchEntry } from "@/components/guide/guide-search";

// Search field of the procedures guide (journey review 2026-10-29): the words typed narrow the
// procedures, accents and case aside, each hit leading to its procedure on the rubric page.

const ENTRIES: GuideSearchEntry[] = [
  { id: "vehicule-mutation", title: "Changer la carte grise d'un véhicule acheté (mutation)", rubric: "vehicule", rubricTitle: "Véhicules" },
  { id: "id-cnie", title: "Obtenir ou renouveler la carte nationale (CNIE)", rubric: "identite", rubricTitle: "Identité et état civil" },
  { id: "pro-ice", title: "Obtenir l'identifiant commun de l'entreprise (ICE)", rubric: "pro-cooperative", rubricTitle: "Sociétés et coopératives" },
];

describe("matchGuideEntries", () => {
  it("returns nothing to show while nothing is typed", () => {
    expect(matchGuideEntries(ENTRIES, "")).toBeNull();
    expect(matchGuideEntries(ENTRIES, " a ")).toBeNull();
  });

  it("keeps the entries holding every word, whatever the accents and the case", () => {
    const ids = (query: string) => matchGuideEntries(ENTRIES, query)?.map((entry) => entry.id);
    expect(ids("CARTE")).toEqual(["vehicule-mutation", "id-cnie"]);
    expect(ids("carte vehicule")).toEqual(["vehicule-mutation"]);
    expect(ids("société")).toEqual(["pro-ice"]);
    expect(ids("passeport")).toEqual([]);
  });
});

describe("GuideSearch", () => {
  it("renders a labelled search field with its hint and no result list yet", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={fr}>
        <GuideSearch entries={ENTRIES} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('type="search"');
    expect(html).toContain(fr.Guide.search.label);
    // The markup escapes the apostrophe of the hint.
    expect(html).toContain(fr.Guide.search.hint.split("'")[0]);
    expect(html).not.toContain("/fr/demarches/vehicule#procedure-vehicule-mutation");
  });
});
