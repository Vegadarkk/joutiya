import { beforeAll, describe, expect, it } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { renderMail } from "@/lib/mail/render";
import { statementParagraphs } from "@/lib/mail/templates/statement";
import type { ModerationStatement } from "@/lib/mail/types";

// Listing mails (design D8): publication, hold and rejection with the art. 17 statement.

const SITE = "https://staging.joutiya.ma";
const statement: ModerationStatement = { measure: "hold", facts: ["new_account", "dup_text"], ground: "CGU §7 (contrôle avant publication)", automated: true, redress: "dsa@joutiya.ma" };

beforeAll(() => {
  process.env.APP_ENV = "dev";
  process.env.SITE_URL = SITE;
  process.env.MAIL_FROM = "Joutiya <no-reply@notif.joutiya.ma>";
  resetServerEnv();
});

describe("listingPublished", () => {
  it("links the public page and names the expiry date, in French and Arabic", () => {
    const fr = renderMail({ template: "listingPublished", locale: "fr", to: "salma@example.com", data: { displayName: "Salma", title: "Vélo de ville", url: `${SITE}/fr/annonce/velo-de-ville-casablanca-abcd2345`, expiresAt: "2026-12-15T10:00:00.000Z" } });
    expect(fr.subject).toBe("Votre annonce « Vélo de ville » est en ligne");
    expect(fr.text).toContain(`${SITE}/fr/annonce/velo-de-ville-casablanca-abcd2345`);
    expect(fr.text).toContain("15 décembre 2026");
    expect(fr.text).toContain(`${SITE}/fr/mes-annonces`);
    expect(fr.text).toContain("ne vous demandera jamais de paiement");
    const ar = renderMail({ template: "listingPublished", locale: "ar", to: "salma@example.com", data: { displayName: "سلمى", title: "دراجة", url: `${SITE}/ar/annonce/draja-abcd2345`, expiresAt: "2026-12-15T10:00:00.000Z" } });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain(`${SITE}/ar/mes-annonces`);
    expect(ar.text).toMatch(/[؀-ۿ]/);
  });
});

describe("statement of reasons", () => {
  it("carries the five elements: measure, facts, ground, automated, redress", () => {
    const fr = statementParagraphs(statement, "fr");
    expect(fr).toHaveLength(5);
    expect(fr[0]).toMatch(/^Mesure : publication suspendue/);
    expect(fr[1]).toContain("compte créé récemment");
    expect(fr[1]).toContain("texte identique à une autre de vos annonces");
    expect(fr[2]).toBe("Fondement : CGU §7 (contrôle avant publication).");
    expect(fr[3]).toMatch(/traitement automatisé/);
    expect(fr[4]).toContain("dsa@joutiya.ma");
    const ar = statementParagraphs({ ...statement, measure: "reject", facts: ["prohibited_kw"] }, "ar");
    expect(ar[0]).toMatch(/^الإجراء: رُفض/);
    expect(ar[1]).toContain("ممنوعة");
    expect(ar[4]).toContain("dsa@joutiya.ma");
  });

  it("keeps a moderator's free-text fact and says so when there is none", () => {
    expect(statementParagraphs({ ...statement, facts: ["Photo d'un produit contrefait"] }, "fr")[1]).toBe("Faits constatés : Photo d'un produit contrefait.");
    expect(statementParagraphs({ ...statement, facts: [] }, "fr")[1]).toMatch(/signaux de risque/);
  });

  it("is rendered by the hold and rejection mails with the right subject and next step", () => {
    const hold = renderMail({ template: "listingPendingReview", locale: "fr", to: "salma@example.com", data: { displayName: "Salma", title: "Vélo", listingId: "abcd2345", statement } });
    expect(hold.subject).toBe("Votre annonce « Vélo » est en cours de vérification");
    expect(hold.text).toContain("Mesure : publication suspendue");
    expect(hold.text).toContain("sous 24 heures");
    expect(hold.text).toContain(`${SITE}/fr/mes-annonces`);
    const rejected = renderMail({ template: "listingRejected", locale: "rif", to: "salma@example.com", data: { displayName: "Salma", title: "Vélo", listingId: "abcd2345", statement: { ...statement, measure: "reject" } } });
    expect(rejected.subject).toBe("Votre annonce « Vélo » n'a pas été publiée");
    expect(rejected.text).toContain("Mesure : annonce refusée");
    // Tarifit falls back to French copy but keeps its own page URLs.
    expect(rejected.text).toContain(`${SITE}/rif/mes-annonces`);
    expect(rejected.html).not.toContain("<script");
  });
});
