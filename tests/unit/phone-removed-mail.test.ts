import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LEGAL } from "@/config/legal";
import { resetServerEnv } from "@/lib/env";
import { isTemplateMail, renderMail, TEMPLATE_IDS } from "@/lib/mail/render";
import { setMailPublisher } from "@/lib/mail/templates/layout";

// The phoneRemoved security mail (number moved to another account): copy per locale, contact
// address from the legal config, button to the verifications page, escaping.

const SITE = "https://staging.joutiya.ma";
const data = { displayName: "Nadia", phone: "06 12 34 56 78" };

beforeAll(() => {
  process.env.APP_ENV = "dev";
  process.env.SITE_URL = SITE;
  process.env.MAIL_FROM = "Joutiya <no-reply@notif.joutiya.ma>";
  resetServerEnv();
});

describe("phoneRemoved", () => {
  it("is a registered template", () => {
    expect(TEMPLATE_IDS).toContain("phoneRemoved");
    expect(isTemplateMail({ template: "phoneRemoved", locale: "fr", to: "nadia@example.com", data })).toBe(true);
  });

  it("explains the removal in French, names the contact address and links to the verifications page", () => {
    const rendered = renderMail({ template: "phoneRemoved", locale: "fr", to: "nadia@example.com", data });
    expect(rendered.subject).toBe("Ton numéro de téléphone a été retiré de ton compte");
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain("Bonjour Nadia,");
      expect(body).toContain("06 12 34 56 78");
      expect(body).toContain("sur un autre compte Joutiya");
      expect(body).toContain("retiré de ton compte");
      expect(body).toContain(DEFAULT_LEGAL.email);
      expect(body).toContain(`${SITE}/fr/verifications`);
      expect(body).not.toMatch(/undefined|\[object Object\]/);
    }
    expect(rendered.html).toContain(`href="${SITE}/fr/verifications"`);
  });

  it("renders in Arabic with the number and the address isolated from the RTL text", () => {
    const rendered = renderMail({ template: "phoneRemoved", locale: "ar", to: "nadia@example.com", data });
    expect(rendered.subject).toBe("تمت إزالة رقم هاتفك من حسابك");
    expect(rendered.html).toContain('<html lang="ar" dir="rtl">');
    expect(rendered.text).toContain("⁦06 12 34 56 78⁩");
    expect(rendered.text).toContain(`⁦${DEFAULT_LEGAL.email}⁩`);
    expect(rendered.text).toContain(`${SITE}/ar/verifications`);
  });

  it("falls back to French for Tarifit but keeps the rif page URL", () => {
    const rendered = renderMail({ template: "phoneRemoved", locale: "rif", to: "nadia@example.com", data });
    expect(rendered.html).toContain('<html lang="fr" dir="ltr">');
    expect(rendered.text).toContain(`${SITE}/rif/verifications`);
  });

  it("escapes interpolated values", () => {
    const rendered = renderMail({ template: "phoneRemoved", locale: "fr", to: "nadia@example.com", data: { displayName: '<img src=x onerror="1">', phone: "<b>0600</b>" } });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).not.toContain("<b>");
    expect(rendered.html).toContain("&lt;b&gt;0600&lt;/b&gt;");
  });
  it("offers the contact address of the legal config, not a constant", () => {
    setMailPublisher({ companyName: "Adark Prime", hqAddress: "6 rue d'Armaillé, 75017 Paris", email: "aide@joutiya.ma" });
    try {
      const rendered = renderMail({ template: "phoneRemoved", locale: "fr", to: "nadia@example.com", data });
      expect(rendered.text).toContain("aide@joutiya.ma");
      expect(rendered.text).not.toContain(DEFAULT_LEGAL.email);
    } finally {
      setMailPublisher();
    }
  });
});
