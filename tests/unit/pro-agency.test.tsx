import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { AgencyTransactions, FeeSchedule } from "@/components/listing/agency-storefront";
import { proAgencySchema } from "@/lib/contracts/pro";
import { firstStrictIssue } from "@/lib/moderation/free-text";
import { AGENCY_FEE_SCHEDULE_MAX, proProfileSchema } from "@/lib/pro/profile-schema";

// Agence pack (design §3): the shop's sector and fee schedule, the agency storefront's blocks.

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("agency sector contract", () => {
  it("takes a sector and a bounded fee schedule, nothing else", () => {
    expect(proAgencySchema.parse({ sector: "real_estate", feeSchedule: "  Vente 2,5 % du prix  " })).toEqual({ sector: "real_estate", feeSchedule: "Vente 2,5 % du prix" });
    expect(proAgencySchema.safeParse({ sector: "real_estate", feeSchedule: "x".repeat(AGENCY_FEE_SCHEDULE_MAX + 1) }).success).toBe(false);
    expect(proAgencySchema.safeParse({ sector: "car_dealer", feeSchedule: "" }).success).toBe(false);
    expect(proAgencySchema.safeParse({ sector: "general", feeSchedule: "", extra: 1 }).success).toBe(false);
  });

  it("stores the sector and the agency block on the profile, strictly", () => {
    const shape = proProfileSchema.shape;
    expect(shape.sector.safeParse("real_estate").success).toBe(true);
    expect(shape.sector.safeParse(undefined).success).toBe(true);
    expect(shape.agency.safeParse({ feeSchedule: "Location : un mois de loyer" }).success).toBe(true);
    expect(shape.agency.safeParse({ feeSchedule: "", card: "123" }).success).toBe(false);
  });

  it("passes a usual fee schedule through the storefront text screen, contact details refused", () => {
    expect(firstStrictIssue("Vente : 2,5 % du prix à la charge de l'acquéreur. Location : un mois de loyer.")).toBeNull();
    expect(firstStrictIssue("Appelez le 06 12 34 56 78")).toBe("phone_in_text");
    expect(firstStrictIssue("Écrivez à agence@exemple.ma")).toBe("email_in_text");
    expect(firstStrictIssue("Barème sur www.agence-atlas.ma")).toBe("url_in_text");
  });
});

describe("agency storefront blocks", () => {
  it("links each transaction with listings to the search narrowed to the shop", () => {
    const html = render(<AgencyTransactions counts={{ vente: 12, location: 1, colocation: 0 }} shopPublicId="u7k2m9p4" />);
    expect(text(html)).toContain("Vente 12 biens en ligne");
    expect(text(html)).toContain("Location 1 bien en ligne");
    expect(text(html)).not.toContain("Colocation");
    expect(html).toContain('href="/fr/recherche?categorie=immobilier&amp;sous-categorie=vente&amp;boutique=u7k2m9p4"');
    expect(render(<AgencyTransactions counts={{}} shopPublicId="u7k2m9p4" />)).toBe("");
  });

  it("shows the fee schedule as the agency wrote it, or nothing", () => {
    const html = render(<FeeSchedule text={"Vente : 2,5 %\nLocation : un mois"} />);
    expect(text(html)).toContain(fr.Storefront.agency.feesTitle);
    expect(html).toMatch(/<p dir="auto"[^>]*>Vente : 2,5 %\nLocation : un mois<\/p>/);
    expect(render(<FeeSchedule text="  " />)).toBe("");
  });
});
