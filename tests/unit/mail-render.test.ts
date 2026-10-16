import { beforeAll, describe, expect, it } from "vitest";
import type { Locale } from "@/config/site";
import { resetServerEnv } from "@/lib/env";
import { renderMail, TEMPLATE_IDS, isTemplateMail } from "@/lib/mail/render";
import { escapeHtml, formatDate } from "@/lib/mail/templates/layout";
import { parseAddress } from "@/lib/mail/transports/brevo";
import type { TemplateData, TemplateId, TemplateMail } from "@/lib/mail/types";

const SITE = "https://staging.joutiya.ma";
const ACTION = "https://staging.joutiya.ma/fr/action?mode=verifyEmail&oobCode=abc-123";
const ADDRESS = "6 rue d'Armaillé, 75017 Paris";

const DATA: { [T in TemplateId]: TemplateData[T] } = {
  verifyEmail: { displayName: "Nadia", actionUrl: ACTION },
  resetPassword: { displayName: "Nadia", actionUrl: ACTION },
  signupExisting: { displayName: "Nadia", loginUrl: `${SITE}/fr/connexion`, resetUrl: `${SITE}/fr/mot-de-passe-oublie` },
  passwordChanged: { displayName: "Nadia", at: "2026-10-16T09:30:00.000Z" },
  staffInvite: { displayName: "Nadia", actionUrl: ACTION, role: "moderator" },
  phoneVerified: { displayName: "Nadia", phone: "+212 6 00 00 00 00" },
  phoneRemoved: { displayName: "Nadia", phone: "+212 6 00 00 00 00" },
  listingPublished: { displayName: "Nadia", title: "Vélo de ville", url: `${SITE}/fr/annonce/velo-de-ville-casablanca-abcd2345`, expiresAt: "2026-12-15T09:30:00.000Z" },
  listingPendingReview: { displayName: "Nadia", title: "Vélo de ville", listingId: "abcd2345", statement: { measure: "hold", facts: ["new_account", "dup_text"], ground: "CGU §7", automated: true, redress: "dsa@joutiya.ma" } },
  listingRejected: { displayName: "Nadia", title: "Vélo de ville", listingId: "abcd2345", statement: { measure: "reject", facts: ["prohibited_kw"], ground: "CGU §7.2", automated: true, redress: "dsa@joutiya.ma" } },
};

/** Every URL a template receives must appear in both bodies. */
function urlsOf(data: Record<string, unknown>): string[] {
  return Object.values(data).filter((value): value is string => typeof value === "string" && value.startsWith("https://"));
}

function mail<T extends TemplateId>(template: T, locale: Locale, data: TemplateData[T] = DATA[template]): TemplateMail<T> {
  return { template, locale, to: "nadia@example.com", data };
}

beforeAll(() => {
  process.env.APP_ENV = "dev";
  process.env.SITE_URL = SITE;
  process.env.MAIL_FROM = "Joutiya <no-reply@notif.joutiya.ma>";
  resetServerEnv();
});

describe("renderMail", () => {
  for (const template of TEMPLATE_IDS) {
    for (const locale of ["fr", "ar", "rif"] as const) {
      it(`${template} / ${locale}: subject, address, links, no undefined`, () => {
        const rendered = renderMail(mail(template, locale));
        expect(rendered.subject.length).toBeGreaterThan(5);
        expect(rendered.from).toBe("Joutiya <no-reply@notif.joutiya.ma>");
        expect(rendered.to).toBe("nadia@example.com");
        expect(rendered.tags).toEqual({ template, env: "dev" });
        expect(rendered.meta?.template).toBe(template);
        for (const body of [rendered.html, rendered.text]) {
          expect(body).toContain(ADDRESS);
          expect(body).toContain("Adark Prime");
          expect(body).toContain(SITE);
          expect(body).toContain("Nadia");
          expect(body).not.toMatch(/undefined|\[object Object\]|NaN/);
        }
        // Raw URL in the text version, attribute-escaped ("&amp;") in the HTML.
        for (const url of urlsOf(DATA[template] as Record<string, unknown>)) {
          expect(rendered.text).toContain(url);
          expect(rendered.html).toContain(`href="${escapeHtml(url)}"`);
          expect(rendered.html).toContain(`>${escapeHtml(url)}</a>`);
        }
        // Every mail carries exactly one primary button whose href is repeated as raw text.
        expect(rendered.html.match(/<a href=/g)?.length).toBeGreaterThanOrEqual(2);
        expect(rendered.html).toContain("max-width:560px");
        expect(rendered.html).not.toMatch(/<img|<script|<style/);
        expect(rendered.html).not.toContain("http://");
        if (locale === "ar") {
          expect(rendered.html).toContain('<html lang="ar" dir="rtl">');
          expect(rendered.text).toContain("Joutiya");
          expect(rendered.text).toMatch(/[؀-ۿ]/);
        } else {
          expect(rendered.html).toContain('<html lang="fr" dir="ltr">');
          expect(rendered.text).toContain("E-mail automatique, merci de ne pas répondre.");
        }
      });
    }
  }

  it("ends security mails with the not-you sentence in both languages", () => {
    for (const template of ["verifyEmail", "resetPassword", "signupExisting"] as const) {
      expect(renderMail(mail(template, "fr")).text).toContain("Si tu n'es pas à l'origine de cette demande, ignore cet e-mail.");
      expect(renderMail(mail(template, "ar")).text).toContain("إذا لم تكن أنت من قام بهذا الطلب");
    }
    expect(renderMail(mail("passwordChanged", "fr")).text).toContain("Si tu n'es pas à l'origine de cette demande");
  });

  it("escapes interpolated values", () => {
    const rendered = renderMail(mail("verifyEmail", "fr", { displayName: '<script>alert("x")</script> & Co', actionUrl: `${ACTION}&x=<y>` }));
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co");
    expect(rendered.html).toContain("oobCode=abc-123&amp;x=&lt;y&gt;");
    expect(rendered.html).not.toContain("<y>");
    // The text version keeps the raw value.
    expect(rendered.text).toContain('<script>alert("x")</script> & Co');
    const phone = renderMail(mail("phoneVerified", "ar", { displayName: "Nadia", phone: "<b>0600</b>" }));
    expect(phone.html).not.toContain("<b>");
  });

  it("formats the password-change date for the recipient and tolerates free text", () => {
    const fr = renderMail(mail("passwordChanged", "fr"));
    expect(fr.text).toContain("16 octobre 2026");
    expect(fr.text).not.toContain("2026-10-16T09:30");
    expect(fr.html).toContain(`${SITE}/fr/mot-de-passe-oublie`);
    const rif = renderMail(mail("passwordChanged", "rif"));
    expect(rif.html).toContain(`${SITE}/rif/mot-de-passe-oublie`);
    expect(formatDate("hier", "fr")).toBe("hier");
  });

  it("names the role in the staff invitation", () => {
    expect(renderMail(mail("staffInvite", "fr", { ...DATA.staffInvite, role: "admin" })).text).toContain("administrateur");
    expect(renderMail(mail("staffInvite", "ar", { ...DATA.staffInvite, role: "moderator" })).text).toContain("مشرف");
  });
});

describe("helpers", () => {
  it("escapeHtml covers the four characters that matter with double-quoted attributes", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;'&amp;'&lt;/a&gt;");
  });

  it("parseAddress splits a display name", () => {
    expect(parseAddress("Joutiya <no-reply@notif.joutiya.ma>")).toEqual({ name: "Joutiya", email: "no-reply@notif.joutiya.ma" });
    expect(parseAddress('"Joutiya Maroc" <no-reply@notif.joutiya.ma>')).toEqual({ name: "Joutiya Maroc", email: "no-reply@notif.joutiya.ma" });
    expect(parseAddress("no-reply@notif.joutiya.ma")).toEqual({ email: "no-reply@notif.joutiya.ma" });
  });

  it("isTemplateMail rejects malformed queue payloads", () => {
    expect(isTemplateMail(mail("verifyEmail", "fr"))).toBe(true);
    expect(isTemplateMail({ ...mail("verifyEmail", "fr"), template: "evil" })).toBe(false);
    expect(isTemplateMail({ ...mail("verifyEmail", "fr"), locale: "en" })).toBe(false);
    expect(isTemplateMail({ ...mail("verifyEmail", "fr"), to: "nobody" })).toBe(false);
    expect(isTemplateMail(null)).toBe(false);
  });
});
