import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { ProCommitments } from "@/components/pro/pro-commitments";
import { GUIDE_PROCEDURES, GUIDE_SOURCES } from "@/content/guide";
import { proAgencySchema } from "@/lib/contracts/pro";
import { checkoutPassSchema } from "@/lib/contracts/payments";
import { COMMITMENT_GUIDE, COMMITMENT_ITEMS, COMMITMENT_SCOPES, guideProcedureHref, sectorCommitmentScope } from "@/lib/pro/commitments";
import { PRO_SECTORS } from "@/lib/pro/profile-schema";

// Legal commitments on shop and agency creation (owner ask 2026-10-29): texts in every locale that
// has the Pro namespace, guide links that exist on the rubric pages, and the acknowledgment the APIs require.

type Commitments = { titles: Record<string, string>; leads: Record<string, string>; items: Record<string, string>; guide: Record<string, string>; accept: Record<string, string> };
const LOCALES = { fr: fr.Pro.commitments, ar: ar.Pro.commitments } as Record<string, Commitments>;

describe("commitments catalogue", () => {
  it("has every text in French and Arabic", () => {
    for (const [locale, texts] of Object.entries(LOCALES)) {
      for (const scope of COMMITMENT_SCOPES) {
        for (const key of ["titles", "leads", "accept"] as const) expect(texts[key][scope], `${locale} ${key}.${scope}`).toBeTruthy();
        for (const item of COMMITMENT_ITEMS[scope]) expect(texts.items[item], `${locale} items.${item}`).toBeTruthy();
        for (const entry of COMMITMENT_GUIDE[scope]) expect(texts.guide[entry.procedure], `${locale} guide.${entry.procedure}`).toBeTruthy();
      }
    }
  });

  it("links only procedures shown on their rubric page (one confirmed official source at least)", () => {
    for (const scope of COMMITMENT_SCOPES) {
      for (const entry of COMMITMENT_GUIDE[scope]) {
        expect(GUIDE_PROCEDURES[entry.procedure].rubric).toBe(entry.rubric);
        expect(GUIDE_PROCEDURES[entry.procedure].sources.some((id) => GUIDE_SOURCES[id].confirmed)).toBe(true);
      }
    }
    expect(guideProcedureHref({ rubric: "pro-cooperative", procedure: "pro-ice" })).toBe("/demarches/pro-cooperative#procedure-pro-ice");
  });

  it("gives every agency sector its own commitments, none to a general shop", () => {
    for (const sector of PRO_SECTORS) expect(sectorCommitmentScope(sector)).toBe(sector === "general" ? null : sector);
  });
});

describe("acknowledgment in the contracts", () => {
  it("takes the agency acknowledgment as true only", () => {
    expect(proAgencySchema.parse({ sector: "real_estate", feeSchedule: "", acceptCommitments: true }).acceptCommitments).toBe(true);
    expect(proAgencySchema.safeParse({ sector: "real_estate", feeSchedule: "", acceptCommitments: false }).success).toBe(false);
  });

  it("requires it for a Pass Boutique", () => {
    expect(checkoutPassSchema.safeParse({ pass: "boutique30", acceptTerms: true, locale: "fr" }).success).toBe(false);
    expect(checkoutPassSchema.safeParse({ pass: "boutique30", acceptTerms: true, acceptCommitments: true, locale: "fr" }).success).toBe(true);
  });
});

describe("ProCommitments", () => {
  const html = (error?: string) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
        <ProCommitments scope="car_rental" checked={false} onCheckedChange={() => undefined} error={error} />
      </NextIntlClientProvider>,
    ).replaceAll("&#x27;", "'");

  it("shows the trade's commitments, the risk of a fake agency, the guide and the box", () => {
    const markup = html();
    expect(markup).toContain(fr.Pro.commitments.titles.car_rental);
    expect(markup).toContain("agrément de location de voitures");
    expect(markup).toContain(fr.Pro.commitments.fakeTitle);
    expect(markup).toContain('href="/fr/demarches/vehicule#procedure-vehicule-mutation"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).not.toContain('role="alert"');
    expect(html("Cochez la case")).toContain('aria-invalid="true"');
  });
});
