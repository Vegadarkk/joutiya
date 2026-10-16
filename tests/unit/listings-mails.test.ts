import { beforeAll, describe, expect, it } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { renderMail } from "@/lib/mail/render";
import { statementParagraphs } from "@/lib/mail/templates/statement";
import type { ModerationStatement } from "@/lib/mail/types";
import { REJECT_REASON_CODES, REJECT_REASONS, reasonFactText, rejectStatementFacts } from "@/lib/moderation/decisions";

// Listing mails (design D8, D9, D16): publication, hold and rejection with the art. 17 statement,
// the moderator's approval (online, or changes approved on a paused or expired listing) and
// rejection, the expiry reminder and the expiry notice.

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

describe("human decisions (moderation queue)", () => {
  const human: ModerationStatement = { measure: "reject", facts: rejectStatementFacts("misleading", "Le prix affiché ne correspond pas au modèle."), ground: REJECT_REASONS.misleading.ground.ref, automated: false, redress: "dsa@joutiya.ma" };

  it("says a moderator decided, translates the reason code, keeps the moderator's words and quotes the reference", () => {
    const fr = statementParagraphs(human, "fr", "abcd2345");
    expect(fr[0]).toMatch(/^Mesure : annonce refusée/);
    expect(fr[1]).toBe("Faits constatés : la description, le prix ou les photos ne correspondent pas au bien proposé ; Le prix affiché ne correspond pas au modèle.");
    expect(fr[2]).toBe("Fondement : CGU « Publication des annonces », exactitude.");
    expect(fr[3]).toMatch(/prise par un modérateur/);
    expect(fr[3]).not.toMatch(/automatisé/);
    expect(fr[4]).toContain("dsa@joutiya.ma");
    expect(fr[4]).toContain("abcd2345");
    expect(fr[4]).toContain("une autre personne");
    const ar = statementParagraphs(human, "ar", "abcd2345");
    expect(ar[1]).toContain("لا تطابق");
    expect(ar[3]).toContain("مشرف");
    expect(ar[4]).toContain("abcd2345");
  });

  it("leaves an unknown reason code or free text as written", () => {
    expect(statementParagraphs({ ...human, facts: ["reason:unknown"] }, "fr")[1]).toBe("Faits constatés : reason:unknown.");
    expect(reasonFactText("reason:scam", "fr")).toMatch(/arnaque/);
    expect(reasonFactText("dup_text", "fr")).toBeUndefined();
  });

  it("every reject reason has both languages and a ground of at most 64 characters", () => {
    for (const code of REJECT_REASON_CODES) {
      const reason = REJECT_REASONS[code];
      expect(reason.label.length).toBeGreaterThan(3);
      expect(reason.facts.fr.length).toBeGreaterThan(10);
      expect(reason.facts.ar).toMatch(/[؀-ۿ]/);
      expect(reason.ground.ref.length).toBeLessThanOrEqual(64);
    }
  });

  it("listingRejected from a moderator: Reply-To the DSA address, human statement", () => {
    const rejected = renderMail({ template: "listingRejected", locale: "fr", to: "salma@example.com", data: { displayName: "Salma", title: "Vélo", listingId: "abcd2345", statement: human } });
    expect(rejected.replyTo).toBe("dsa@joutiya.ma");
    expect(rejected.text).toContain("prise par un modérateur");
    expect(rejected.text).toContain("référence abcd2345");
    const hold = renderMail({ template: "listingPendingReview", locale: "ar", to: "salma@example.com", data: { displayName: "سلمى", title: "دراجة", listingId: "abcd2345", statement } });
    expect(hold.replyTo).toBe("dsa@joutiya.ma");
    // Other mails keep the no-reply sender only.
    expect(renderMail({ template: "listingPublished", locale: "fr", to: "salma@example.com", data: { displayName: "Salma", title: "Vélo", url: `${SITE}/fr/annonce/velo-abcd2345`, expiresAt: "2026-12-15T10:00:00.000Z" } }).replyTo).toBeUndefined();
  });

  it("listingApproved links the public page and names the expiry date", () => {
    const url = `${SITE}/fr/annonce/velo-de-ville-casablanca-abcd2345`;
    const fr = renderMail({ template: "listingApproved", locale: "fr", to: "salma@example.com", data: { displayName: "Salma", title: "Vélo de ville", url, expiresAt: "2026-12-15T10:00:00.000Z" } });
    expect(fr.subject).toBe("Votre annonce « Vélo de ville » a été vérifiée et publiée");
    expect(fr.text).toContain("Un modérateur a vérifié votre annonce");
    expect(fr.text).toContain(url);
    expect(fr.text).toContain("15 décembre 2026");
    expect(fr.text).toContain(`${SITE}/fr/mes-annonces`);
    const ar = renderMail({ template: "listingApproved", locale: "ar", to: "salma@example.com", data: { displayName: "سلمى", title: "دراجة", url: `${SITE}/ar/annonce/draja-abcd2345`, expiresAt: "2026-12-15T10:00:00.000Z" } });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.subject).toContain("دراجة");
  });

  it("listingChangesApproved: changes approved, never claims the listing is online (paused: resume until expiry; expired: renew until purge)", () => {
    const base = { displayName: "Salma", title: "Vélo de ville" };
    const paused = renderMail({ template: "listingChangesApproved", locale: "fr", to: "salma@example.com", data: { ...base, status: "paused", url: `${SITE}/fr/mes-annonces?onglet=active`, until: "2026-12-15T10:00:00.000Z" } });
    expect(paused.subject).toBe("Les modifications de votre annonce « Vélo de ville » sont validées");
    expect(paused.text).toContain("Un modérateur a vérifié les modifications");
    expect(paused.text).toContain("reste en pause");
    expect(paused.text).toContain("15 décembre 2026");
    expect(paused.text).toContain(`${SITE}/fr/mes-annonces?onglet=active`);
    expect(paused.html).toContain("Remettre mon annonce en ligne");
    const expired = renderMail({ template: "listingChangesApproved", locale: "fr", to: "salma@example.com", data: { ...base, status: "expired", url: `${SITE}/fr/mes-annonces?onglet=ended`, until: "2027-12-15T10:00:00.000Z" } });
    expect(expired.text).toContain("a expiré");
    expect(expired.text).toContain("renouveler gratuitement");
    expect(expired.text).toMatch(/15 décembre 2027(?! à)/);
    expect(expired.html).toContain("Renouveler mon annonce");
    for (const mail of [paused, expired]) {
      expect(mail.text).not.toMatch(/maintenant visible|est en ligne|publiée/);
      expect(mail.text).toContain("n'est pas visible sur Joutiya");
    }
    const ar = renderMail({ template: "listingChangesApproved", locale: "ar", to: "salma@example.com", data: { displayName: "سلمى", title: "دراجة", status: "expired", url: `${SITE}/ar/mes-annonces?onglet=ended`, until: "2027-12-15T10:00:00.000Z" } });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain("تجديده مجانًا");
    expect(ar.text).toContain(`${SITE}/ar/mes-annonces?onglet=ended`);
  });
});

describe("expiry mails", () => {
  it("listingExpiringSoon names the date, renews from Mes annonces and links the listing (Tarifit: French copy, own URLs)", () => {
    const url = `${SITE}/rif/annonce/velo-abcd2345`;
    const mail = renderMail({ template: "listingExpiringSoon", locale: "rif", to: "salma@example.com", data: { displayName: "Salma", title: "Vélo", url, expiresAt: "2026-10-19T14:00:00.000Z" } });
    expect(mail.subject).toBe("Votre annonce « Vélo » expire bientôt");
    expect(mail.text).toContain("19 octobre 2026");
    expect(mail.text).toContain(`${SITE}/rif/mes-annonces`);
    expect(mail.text).toContain(url);
    expect(mail.html).toContain('<html lang="fr" dir="ltr">');
    const ar = renderMail({ template: "listingExpiringSoon", locale: "ar", to: "salma@example.com", data: { displayName: "سلمى", title: "دراجة", url, expiresAt: "2026-10-19T14:00:00.000Z" } });
    expect(ar.text).toMatch(/[؀-ۿ]/);
    expect(ar.text).toContain(`${SITE}/ar/mes-annonces`);
  });

  it("listingExpired gives the last renewal day (no time) and warns about the deletion", () => {
    const mail = renderMail({ template: "listingExpired", locale: "fr", to: "salma@example.com", data: { displayName: "Salma", title: "Vélo", purgeAt: "2027-10-16T02:30:00.000Z" } });
    expect(mail.subject).toBe("Votre annonce « Vélo » a expiré");
    expect(mail.text).toContain("jusqu'au 16 octobre 2027.");
    expect(mail.text).toContain("supprimée définitivement");
    expect(mail.text).toContain(`${SITE}/fr/mes-annonces`);
    const ar = renderMail({ template: "listingExpired", locale: "ar", to: "salma@example.com", data: { displayName: "سلمى", title: "دراجة", purgeAt: "2027-10-16T02:30:00.000Z" } });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain("سيُحذف");
  });

  it("interpolated titles are escaped in the HTML", () => {
    const mail = renderMail({ template: "listingExpired", locale: "fr", to: "salma@example.com", data: { displayName: "Salma", title: "<img src=x onerror=alert(1)>", purgeAt: "2027-10-16T02:30:00.000Z" } });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });
});
