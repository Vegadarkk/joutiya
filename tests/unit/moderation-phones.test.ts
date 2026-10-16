import { describe, expect, it } from "vitest";
import { containsPhoneNumber, deobfuscatePhoneText, findPhoneNumbers } from "@/lib/moderation/phones";

const e164s = (text: string) => findPhoneNumbers(text).map((match) => match.e164);

describe("findPhoneNumbers: true positives", () => {
  it.each([
    ["Appelez le 06 12 34 56 78 svp", "06 12 34 56 78"],
    ["tel 0612345678", "0612345678"],
    ["tel:0612345678", "0612345678"],
    ["+212 6 12 34 56 78", "+212 6 12 34 56 78"],
    ["00212612345678", "00212612345678"],
    ["(+212) 612-345678", "(+212) 612-345678"],
    ["06.12.34.56.78", "06.12.34.56.78"],
    ["06-12-34-56-78", "06-12-34-56-78"],
    ["06 - 12 - 34 - 56 - 78", "06 - 12 - 34 - 56 - 78"],
    ["0612 345 678", "0612 345 678"],
    ["numéro 0 6 1 2 3 4 5 6 7 8", "0 6 1 2 3 4 5 6 7 8"],
    ["wa.me/212612345678", "212612345678"],
    ["fixe 0522123456", "0522123456"],
    ["0708091011", "0708091011"],
  ])("finds the Moroccan number in %j", (text, raw) => {
    const matches = findPhoneNumbers(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.raw).toBe(raw);
    expect(matches[0]?.e164).toMatch(/^\+212[5-7]\d{8}$/);
  });

  it("reads Arabic-Indic digits, with or without spaces", () => {
    expect(e164s("اتصل على ٠٦١٢٣٤٥٦٧٨")).toEqual(["+212612345678"]);
    expect(e164s("٠٦ ١٢ ٣٤ ٥٦ ٧٨")).toEqual(["+212612345678"]);
    expect(e164s("۰۶۱۲۳۴۵۶۷۸")).toEqual(["+212612345678"]);
  });

  it("reads obfuscated forms: slashes, underscores, stars, letter o as zero, glued words", () => {
    expect(e164s("06/12/34/56/78")).toEqual(["+212612345678"]);
    expect(e164s("06_12_34_56_78")).toEqual(["+212612345678"]);
    expect(e164s("06*12*34*56*78")).toEqual(["+212612345678"]);
    expect(e164s("o6 12 34 56 78")).toEqual(["+212612345678"]);
    expect(e164s("O612345678")).toEqual(["+212612345678"]);
    expect(e164s("06 12 34 56 7o")).toEqual(["+212612345670"]);
    expect(e164s("tel0612345678")).toEqual(["+212612345678"]);
    expect(e164s("0612345678whatsapp")).toEqual(["+212612345678"]);
    expect(findPhoneNumbers("o6 12 34 56 78")[0]?.raw).toBe("o6 12 34 56 78");
  });

  it("keeps a contiguous national number without its trunk zero, and foreign numbers", () => {
    expect(e164s("whatsapp 612345678")).toEqual(["+212612345678"]);
    expect(e164s("+33 6 12 34 56 78")).toEqual(["+33612345678"]);
    expect(e164s("0033612345678")).toEqual(["+33612345678"]);
  });

  it("returns every distinct number once, in text order", () => {
    expect(e164s("whatsapp 0612345678 ou 0698765432")).toEqual(["+212612345678", "+212698765432"]);
    expect(e164s("0612345678 / 06 12 34 56 78 / +212612345678")).toEqual(["+212612345678"]);
    expect(e164s("0612345678/0712345678")).toEqual(["+212612345678", "+212712345678"]);
  });

  it("exposes containsPhoneNumber", () => {
    expect(containsPhoneNumber("appelez le 0612345678")).toBe(true);
    expect(containsPhoneNumber("appelez-moi via la messagerie")).toBe(false);
  });
});

describe("findPhoneNumbers: false positives", () => {
  it.each([
    "2006 Peugeot 206",
    "150 000 km",
    "12 500 DH",
    "iPhone 13 128 Go",
    "Samsung Galaxy S23 256 Go 4500 dh",
    "prix 1200000 dh",
    "Prix: 1 250 000 DH",
    "Prix 05 000 000 dh",
    "surface 120 m2 3 chambres",
    "année 2015, 95000 km, 85 000 DH",
    "Toyota Yaris 2012 120000 km 65000 dh",
    "Disponible le 05/12/2024 12h",
    "le 06/12/2024 12",
    "livraison le 06.12.2024 entre 12 et 14h",
    "tailles 36 38 40 42 44",
    "pointures 5 6 7 8 9 10 11 12",
    "garage 6 12 34 56 78",
    "ref 123456789",
    "IMEI 356938035643809",
    "Numéro de série 2345678901234567",
    "4 pneus 205 55 r16 2500 dh",
    "80 000 à 100 000 dh",
    "Go 128 iPhone 6",
    "2 o 3 personnes",
    "lot de 10 pièces à 0,5 dh",
    "sept chambres 450 000 dh 95 m2 année 2019 étage 3 ascenseur 2 salles de bain",
    "2 lits 160x200 1 armoire 3 portes 2 chevets 1500 dh",
    "",
    "aucun chiffre ici",
  ])("ignores %j", (text) => {
    expect(findPhoneNumbers(text)).toEqual([]);
  });
});

describe("deobfuscatePhoneText", () => {
  it("keeps the length so spans map back to the original text", () => {
    for (const text of ["٠٦ ١٢ ٣٤ ٥٦ ٧٨", "o6/12/34/56/78", "Go 128 iPhone 6 o6 12 34 56 78", "aucun chiffre"]) {
      expect(deobfuscatePhoneText(text)).toHaveLength(text.length);
    }
    expect(deobfuscatePhoneText("o6/12/34/56/78")).toBe("06 12 34 56 78");
    expect(deobfuscatePhoneText("iPhone Go 128")).toBe("iPhone Go 128");
  });
});
