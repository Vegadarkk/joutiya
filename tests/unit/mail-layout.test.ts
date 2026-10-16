import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LEGAL } from "@/config/legal";
import { mailPublisher, PUBLISHER_ADDRESS, renderLayout, setMailPublisher } from "@/lib/mail/templates/layout";

// S8: the footer identity comes from config/legal (setMailPublisher in deliverMail), never from
// a hardcoded name; the Paris domiciliation is the only address ever displayed, and the fallback.

const INPUT = { lang: "fr" as const, siteUrl: "https://joutiya.test", subject: "Sujet", title: "Titre", greeting: "Bonjour Nadia,", paragraphs: ["Corps."] };

afterEach(() => setMailPublisher());

describe("mailPublisher", () => {
  it("falls back to the defaults and the Paris address", () => {
    expect(PUBLISHER_ADDRESS).toBe("6 rue d'Armaillé, 75017 Paris");
    expect(DEFAULT_LEGAL.hqAddress).toBe(PUBLISHER_ADDRESS);
    expect(mailPublisher()).toEqual({ name: DEFAULT_LEGAL.companyName, address: PUBLISHER_ADDRESS });
    expect(mailPublisher({ companyName: "  ", hqAddress: "" })).toEqual({ name: DEFAULT_LEGAL.companyName, address: PUBLISHER_ADDRESS });
    expect(mailPublisher({ companyName: " Joutiya SAS ", hqAddress: PUBLISHER_ADDRESS })).toEqual({ name: "Joutiya SAS", address: PUBLISHER_ADDRESS });
  });
});

describe("renderLayout footer", () => {
  it("renders the publisher set from the legal config, in both languages", () => {
    setMailPublisher({ companyName: "Société Test", hqAddress: PUBLISHER_ADDRESS });
    const fr = renderLayout(INPUT);
    expect(fr.text).toContain(`Édité par Société Test · ${PUBLISHER_ADDRESS}`);
    expect(fr.html).toContain(`Édité par Société Test · ${PUBLISHER_ADDRESS}`);
    expect(fr.html).not.toContain(DEFAULT_LEGAL.companyName);
    const ar = renderLayout({ ...INPUT, lang: "ar" });
    expect(ar.text).toContain(`الناشر: Société Test · ${PUBLISHER_ADDRESS}`);
  });

  it("escapes the publisher name and lets a template pass its own", () => {
    setMailPublisher({ companyName: "A & B <SAS>", hqAddress: PUBLISHER_ADDRESS });
    expect(renderLayout(INPUT).html).toContain("Édité par A &amp; B &lt;SAS&gt;");
    const explicit = renderLayout({ ...INPUT, publisher: { name: "Explicite", address: PUBLISHER_ADDRESS } });
    expect(explicit.text).toContain("Édité par Explicite");
    setMailPublisher();
    expect(renderLayout(INPUT).text).toContain(`Édité par ${DEFAULT_LEGAL.companyName} · ${PUBLISHER_ADDRESS}`);
  });
});
