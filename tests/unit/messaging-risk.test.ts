import { describe, expect, it } from "vitest";
import { CONTACT_APP_KEYWORDS, PAYMENT_KEYWORDS } from "@/config/payment-keywords";
import { URL_MARKER, sendMessageSchema, stripFormatCharacters } from "@/lib/contracts/messaging";
import { analyzeMessage, findLinks, isOwnLink, linkHost, maskLinks, messagePreview } from "@/lib/messaging/risk";
import { tokenize } from "@/lib/text/normalize";

// Message risk (design D5): links masked and flagged (joutiya.ma excepted), bank details, payment
// vocabulary in French, Arabic and darija, and contact + payment together. A phone number or a
// WhatsApp mention alone is never flagged.

describe("maskLinks", () => {
  it.each([
    ["voir https://evil.example.com/pay?x=1 merci", `voir ${URL_MARKER} merci`],
    ["mon site www.monsite.ma, promo", `mon site ${URL_MARKER}, promo`],
    ["écrivez-moi sur wa.me/212612345678", `écrivez-moi sur ${URL_MARKER}`],
    ["groupe t.me/bonplans.", `groupe ${URL_MARKER}.`],
    ["visitez monsite.com/offre et paiement.net", `visitez ${URL_MARKER} et ${URL_MARKER}`],
    ["HTTP://EXEMPLE.FR", URL_MARKER],
  ])("masks %j", (text, expected) => {
    expect(maskLinks(text).text).toBe(expected);
  });

  it("keeps links to joutiya.ma and its subdomains, not look-alikes", () => {
    expect(maskLinks("voir https://joutiya.ma/fr/annonce/velo-abcd2345").count).toBe(0);
    expect(maskLinks("www.joutiya.ma/aide").count).toBe(0);
    expect(maskLinks("joutiya.ma").count).toBe(0);
    expect(maskLinks("https://joutiya.ma.evil.com/x").text).toBe(URL_MARKER);
    expect(maskLinks("faux-joutiya.ma/login").text).toBe(URL_MARKER);
    expect(isOwnLink("https://user@media.joutiya.ma:443/x")).toBe(true);
    expect(linkHost("https://user:pw@Evil.Com:8080/path?q")).toBe("evil.com");
  });

  it("leaves e-mail addresses, numbers and ordinary punctuation alone", () => {
    for (const text of ["mail: john.fr@gmail.com", "taille 38.5 com neuf", "Peugeot 206. Ma voiture", "prix 1.5 ma", "appelez.me", "fichier photo.jpg"]) {
      expect(maskLinks(text)).toEqual({ text, count: 0 });
    }
  });

  it("finds links in text order without overlaps", () => {
    expect(findLinks("a https://x.com/a b.ma c").map((link) => link.raw)).toEqual(["https://x.com/a", "b.ma"]);
  });
});

describe("analyzeMessage", () => {
  it("flags and masks external links, keeping the original apart", () => {
    const result = analyzeMessage("Regardez https://bon-plan.example.com/annonce");
    expect(result).toEqual({ text: `Regardez ${URL_MARKER}`, flags: ["external_url"], masked: true });
  });

  it("does not flag a phone number or WhatsApp alone (normal in Morocco)", () => {
    for (const text of ["Appelez-moi au 06 12 34 56 78", "Je suis sur WhatsApp, 0612345678", "واتساب 0612345678", "Bonjour, toujours disponible ?"]) {
      expect(analyzeMessage(text)).toEqual({ text, flags: [], masked: false });
    }
  });

  it("flags bank details (IBAN, RIB, card)", () => {
    expect(analyzeMessage("Mon IBAN FR76 3000 6000 0112 3456 7890 189").flags).toEqual(["iban"]);
    expect(analyzeMessage("RIB 011 780 0000123456789012 34 merci").flags).toEqual(["iban"]);
    expect(analyzeMessage("carte 4111 1111 1111 1111").flags).toEqual(["iban"]);
  });

  it.each([
    "Envoyez un acompte de 500 dh",
    "Paiement par Western Union uniquement",
    "je veux l'avance avant",
    "Il faut un virement d'abord",
    "خاصك تعطي العربون",
    "صيفط التسبيق",
    "3tini tsbi9 3afak",
    "khass l3arboun 9bel",
    "Wafacash ou Cash Plus",
  ])("flags payment vocabulary: %j", (text) => {
    expect(analyzeMessage(text).flags).toContain("payment_kw");
    expect(analyzeMessage(text).flags).not.toContain("contact_with_payment_kw");
  });

  it("flags a contact (phone or messaging app) together with a payment keyword", () => {
    expect(analyzeMessage("Envoyez l'acompte et appelez le 0612345678").flags).toEqual(["payment_kw", "contact_with_payment_kw"]);
    expect(analyzeMessage("virement puis on parle sur whatsapp").flags).toEqual(["payment_kw", "contact_with_payment_kw"]);
    expect(analyzeMessage("حوالة ومن بعد واتساب").flags).toEqual(["payment_kw", "contact_with_payment_kw"]);
  });

  it("returns every flag once, in the contract order", () => {
    const result = analyzeMessage("Acompte par virement sur FR76 3000 6000 0112 3456 7890 189, détails sur wa.me/212612345678");
    expect(result.flags).toEqual(["external_url", "iban", "payment_kw", "contact_with_payment_kw"]);
    expect(result.text).toBe(`Acompte par virement sur FR76 3000 6000 0112 3456 7890 189, détails sur ${URL_MARKER}`);
  });
});

describe("messagePreview", () => {
  it("keeps short texts on one line", () => {
    expect(messagePreview("Bonjour\n\nencore   dispo ?")).toBe("Bonjour encore dispo ?");
  });

  it("cuts at 140 UTF-16 units with an ellipsis, never inside a surrogate pair or a marker", () => {
    const long = "é".repeat(200);
    expect(messagePreview(long)).toHaveLength(140);
    expect(messagePreview(long).endsWith("…")).toBe(true);
    const emoji = "😀".repeat(100);
    const preview = messagePreview(emoji);
    expect(preview.length).toBeLessThanOrEqual(140);
    expect(preview.slice(0, -1)).toBe("😀".repeat(69));
    const marker = `${"a".repeat(136)} ${URL_MARKER} fin`;
    expect(messagePreview(marker)).toBe(`${"a".repeat(136)}…`);
  });
});

describe("keyword lists", () => {
  it("are non-empty, unique once normalized, and match a normalized form", () => {
    for (const list of [PAYMENT_KEYWORDS, CONTACT_APP_KEYWORDS]) {
      const normalized = list.map((term) => tokenize(term).join(" "));
      expect(normalized.every((term) => term.length > 0)).toBe(true);
      expect(new Set(normalized).size).toBe(normalized.length);
    }
  });

  it("never collide: a contact app is not a payment keyword", () => {
    const payment = new Set(PAYMENT_KEYWORDS.map((term) => tokenize(term).join(" ")));
    expect(CONTACT_APP_KEYWORDS.filter((term) => payment.has(tokenize(term).join(" ")))).toEqual([]);
  });
});

describe("message text contract", () => {
  it("refuses the reserved markers and control characters", () => {
    expect(sendMessageSchema.safeParse({ text: `x ${URL_MARKER}` }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ text: "a\u0000b" }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ text: "ligne 1\nligne 2" }).success).toBe(true);
  });

  // Audit D1a-11: format characters (Cf) are dropped before validation and analysis.
  describe("format characters", () => {
    const parse = (text: string) => sendMessageSchema.parse({ text }).text;

    it("strips zero-width, bidi, soft hyphen and BOM characters, keeps ZWNJ and ZWJ", () => {
      expect(stripFormatCharacters("a​b‎‏c‪‮‬d⁦⁩e﻿­⁠f")).toBe("abcdef");
      expect(stripFormatCharacters("می‌خواهم")).toBe("می‌خواهم");
      expect(stripFormatCharacters("👨‍👩‍👧")).toBe("👨‍👩‍👧");
      expect(parse("‎ Salam ‬")).toBe("Salam");
      expect(sendMessageSchema.safeParse({ text: "​﻿" }).success).toBe(false);
      expect(sendMessageSchema.safeParse({ text: `${"x".repeat(2000)}​` }).success).toBe(true);
    });

    it("keeps a zero-width-split WhatsApp mention, an RTL-override IBAN and a split domain detectable", () => {
      const whatsapp = parse("virement puis on parle sur w​h​a​t​s​a​p​p");
      expect(analyzeMessage(whatsapp).flags).toEqual(["payment_kw", "contact_with_payment_kw"]);
      const iban = parse("Mon IBAN ‮FR76 3000​6000 0112 3456 7890 189‬");
      expect(analyzeMessage(iban).flags).toEqual(["iban"]);
      const url = parse("voir https://evil​.example.com/pay merci");
      expect(analyzeMessage(url)).toMatchObject({ text: `voir ${URL_MARKER} merci`, flags: ["external_url"], masked: true });
    });
  });
});
