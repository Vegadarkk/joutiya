import { beforeAll, describe, expect, it } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { renderMail } from "@/lib/mail/render";
import { unsubscribeApiUrl } from "@/lib/mail/templates/savedSearchAlert";
import { MemoryTransport, memoryMailbox } from "@/lib/mail/transports/memory";
import type { TemplateData, TemplateMail } from "@/lib/mail/types";

// D19/D20: the savedSearchAlert digest in French and Arabic, its List-Unsubscribe headers (RFC 2369
// + RFC 8058 one-click) and the confirm-page link; headers reach the transports.

const SITE = "https://staging.joutiya.ma";
const TOKEN = "djEudWlkLTEuKg.c2lnbmF0dXJlLW9mLWZvcnR5LXRocmVlLWNoYXJhY3RlcnMtYWE"; // gitleaks:allow (fake fixture: base64 of "v1.uid…" and "signature-of-forty-three-characters-aa")

const DATA: TemplateData["savedSearchAlert"] = {
  displayName: "Nadia",
  searches: [
    {
      name: "Vélos <Casa> & co",
      url: `${SITE}/fr/recherche?sous-categorie=velos&ville=casablanca`,
      total: 12,
      listings: [
        { title: "Vélo de ville", url: `${SITE}/fr/annonce/velo-de-ville-casablanca-abcd2345`, price: 1500, isDonation: false, citySlug: "casablanca" },
        { title: "Vélo enfant", url: `${SITE}/fr/annonce/velo-enfant-rabat-efgh2345`, price: null, isDonation: true, citySlug: "rabat" },
      ],
    },
    { name: "Appartements", url: `${SITE}/fr/recherche?sous-categorie=appartements`, total: 1, listings: [{ title: "F3 Maarif", url: `${SITE}/fr/annonce/f3-maarif-casablanca-jkmn2345`, price: null, isDonation: false, citySlug: null }] },
  ],
  unsubscribeToken: TOKEN,
};

function mail(locale: "fr" | "ar" | "rif", data: TemplateData["savedSearchAlert"] = DATA): TemplateMail<"savedSearchAlert"> {
  return { template: "savedSearchAlert", locale, to: "nadia@example.com", data };
}

beforeAll(() => {
  process.env.APP_ENV = "dev";
  process.env.SITE_URL = SITE;
  process.env.MAIL_FROM = "Aalan <no-reply@notif.joutiya.ma>";
  resetServerEnv();
});

describe("savedSearchAlert", () => {
  it("carries the one-click List-Unsubscribe headers", () => {
    const rendered = renderMail(mail("fr"));
    expect(rendered.headers).toEqual({ "List-Unsubscribe": `<${SITE}/api/alerts/unsubscribe?t=${TOKEN}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(unsubscribeApiUrl(`${SITE}/`, "a.b")).toBe(`${SITE}/api/alerts/unsubscribe?t=a.b`);
  });

  it("renders one block per search with its listings, in French", () => {
    const rendered = renderMail(mail("fr"));
    expect(rendered.subject).toBe("13 nouvelles annonces pour vos recherches");
    for (const body of [rendered.text, rendered.html]) {
      expect(body).toContain("Du nouveau pour vos recherches");
      expect(body).toContain("12 nouvelles annonces");
      expect(body).toContain("1 nouvelle annonce");
      expect(body).toContain("Voir les 12 annonces");
      expect(body).toContain("Voir la recherche");
      expect(body).toContain("Don, Rabat");
      expect(body).toContain("Prix à discuter");
      expect(body).toContain(`${SITE}/fr/recherches`);
      expect(body).toContain(`${SITE}/fr/alertes/desabonnement?t=${TOKEN}`);
    }
    expect(rendered.text).toContain("Vélos <Casa> & co");
    expect(rendered.html).toContain("Vélos &lt;Casa&gt; &amp; co");
    expect(rendered.html).not.toContain("<Casa>");
    expect(rendered.html).toContain(`href="${SITE}/fr/annonce/velo-de-ville-casablanca-abcd2345"`);
    expect(rendered.html).not.toMatch(/<img|<script/);
    expect(rendered.text).toContain("1 500 DH, Casablanca");
  });

  it("puts the favorites on promotion first, with the struck-out price", () => {
    const favorites: NonNullable<TemplateData["savedSearchAlert"]["favorites"]> = [
      { title: "Veste en laine", url: `${SITE}/fr/annonce/veste-fes-abcd2345`, price: 960, isDonation: false, citySlug: "fes", kind: "soldes", before: 1200, percent: 20 },
      { title: "Miel de thym", url: `${SITE}/fr/annonce/miel-fes-efgh2345`, price: 90, isDonation: false, citySlug: null, kind: "flash", before: null, percent: 0 },
    ];
    const both = renderMail(mail("fr", { ...DATA, favorites }));
    expect(both.subject).toBe("13 nouvelles annonces pour vos recherches");
    expect(both.text.indexOf("Vos favoris en promotion")).toBeLessThan(both.text.indexOf("Vélos <Casa> & co"));
    expect(both.text).toMatch(/960\sDH au lieu de 1\s200\sDH, Soldes −20 %, Fès/);
    expect(both.text).toMatch(/90\sDH, Vente flash\)/);
    expect(both.text).toContain(`${SITE}/fr/favoris`);
    const only = renderMail(mail("fr", { ...DATA, searches: [], favorites }));
    expect(only.subject).toBe("2 de vos favoris sont en promotion");
    expect(only.text).not.toContain("recherches sauvegardées.");
    expect(renderMail(mail("ar", { ...DATA, searches: [], favorites: favorites.slice(0, 1) })).subject).toBe("أحد إعلاناتك المفضلة عليه تخفيض");
  });

  it("names a map zone by its radius and nearest city, in French and Arabic", () => {
    const zoned: TemplateData["savedSearchAlert"] = { ...DATA, searches: [{ ...(DATA.searches[0] as TemplateData["savedSearchAlert"]["searches"][number]), name: "Ma zone", zone: { km: 12, citySlug: "casablanca" } }] };
    expect(renderMail(mail("fr", zoned)).text).toContain("12 nouvelles annonces — Zone de la carte · 12 km autour de Casablanca");
    expect(renderMail(mail("ar", zoned)).text).toContain("منطقة الخريطة · 12 كلم حول الدار البيضاء");
  });

  it("names the only search in the subject and writes Arabic right to left", () => {
    const one = { ...DATA, searches: [DATA.searches[0]!] };
    expect(renderMail(mail("fr", one)).subject).toBe("12 nouvelles annonces pour « Vélos <Casa> & co »");
    const ar = renderMail(mail("ar", one));
    expect(ar.subject).toContain("«Vélos <Casa> & co»");
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.text).toContain("عدد الإعلانات الجديدة: 12");
    expect(ar.text).toContain("الدار البيضاء");
    expect(ar.text).toContain("مجانًا");
    expect(ar.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("keeps Tarifit URLs with French copy", () => {
    const rif = renderMail(mail("rif"));
    expect(rif.text).toContain("Du nouveau pour vos recherches");
    expect(rif.text).toContain(`${SITE}/rif/recherches`);
  });

  it("reaches the dev mailbox with its headers", async () => {
    const rendered = renderMail(mail("fr"));
    await new MemoryTransport().send(rendered);
    expect(memoryMailbox().list({ to: "nadia@example.com", template: "savedSearchAlert" })[0]?.headers).toEqual(rendered.headers);
  });
});
