import { describe, expect, it } from "vitest";
import { ambiguousLexiconKeys, arabiziCanonical, classifyToken, foldDigits, normalizeQuery } from "@/lib/search/normalize";
import { districtKey, parseSearchParams } from "@/lib/search/params";

// Token tests of the research reference implementation (darija-synonyms.json, arabizi.rule.tests).
const TOKEN_CASES: [input: string, cls: "N" | "P" | "A", key: string][] = [
  ["iphone13", "P", "iphone13"],
  ["iphone", "N", "iphone"],
  ["13", "N", "13"],
  ["golf7", "P", "golf7"],
  ["206", "N", "206"],
  ["clio", "N", "clio"],
  ["4", "N", "4"],
  ["5000dh", "P", "5000dh"],
  ["128go", "P", "128go"],
  ["2eme", "P", "2eme"],
  ["f3", "P", "f3"],
  ["ps5", "P", "ps5"],
  ["s23u", "P", "s23u"],
  ["5g", "P", "5g"],
  ["4g", "N", "4g"],
  ["1.5dci", "N", "1.5dci"],
  ["0612345678", "N", "0612345678"],
  ["3lach", "A", "alach"],
  ["7out", "A", "hout"],
  ["9ahwa", "A", "qahwa"],
  ["5ouya", "A", "khouya"],
  ["bi3", "A", "bia"],
  ["s3ar", "A", "saar"],
  ["m3a", "A", "maa"],
  ["7ammam", "A", "hammam"],
  ["l3id", "A", "laid"],
  ["jam3", "A", "jama"],
  ["x5", "P", "x5"],
  ["a3", "P", "a3"],
  ["t3", "P", "t3"],
  ["3am", "A", "aam"],
  ["2ila", "A", "ila"],
  ["kra", "N", "kra"],
  ["9ba", "A", "qba"],
  ["i7", "P", "i7"],
  ["b2b", "P", "b2b"],
  ["mp3", "P", "mp3"],
  // Digit-first models and ordinals (oneplus 8t, xiaomi 9rt, airpods 3rd): "3rd" keys to "ard" (terrain).
  ["8t", "P", "8t"],
  ["7t", "P", "7t"],
  ["9rt", "P", "9rt"],
  ["3rd", "P", "3rd"],
  ["5th", "P", "5th"],
];

describe("classifyToken (arabizi digit guard)", () => {
  it.each(TOKEN_CASES)("%s -> %s %s", (input, cls, key) => {
    expect(classifyToken(input)).toEqual({ cls, key });
  });

  it("classifies multi-token queries word by word", () => {
    const classes = (query: string) => query.split(" ").map((token) => classifyToken(token));
    expect(classes("iphone 13").map((c) => c.cls)).toEqual(["N", "N"]);
    expect(classes("golf 7").map((c) => c.cls)).toEqual(["N", "N"]);
    expect(classes("clio 4").map((c) => c.cls)).toEqual(["N", "N"]);
    expect(classes("3lach 7out")).toEqual([
      { cls: "A", key: "alach" },
      { cls: "A", key: "hout" },
    ]);
  });

  it("folds accents and case before classifying", () => {
    expect(classifyToken("Bi3")).toEqual({ cls: "A", key: "bia" });
    expect(classifyToken("Réf")).toEqual({ cls: "N", key: "ref" });
  });
});

describe("foldDigits", () => {
  it("maps Arabic-Indic and Persian digits to ASCII", () => {
    expect(foldDigits("٢٠١٩ ۳ ٩٠٠٠ درهم")).toBe("2019 3 9000 درهم");
    expect(foldDigits("golf 7")).toBe("golf 7");
  });
});

describe("normalizeQuery", () => {
  it("trims, collapses spaces and caps the length", () => {
    expect(normalizeQuery("  golf   7  ")).toBe("golf 7");
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery("a ".repeat(80)).length).toBeLessThanOrEqual(100);
  });

  it("never cuts a surrogate pair in half at the length cap", () => {
    // A lone surrogate is sent as "\ud83d", which Meilisearch's JSON parser rejects (400, then 500).
    const q = `${"a".repeat(99)}😀`;
    expect(normalizeQuery(q)).toBe("a".repeat(99));
    expect(normalizeQuery(q).isWellFormed()).toBe(true);
    expect(parseSearchParams(new URLSearchParams({ q })).q).toBe("a".repeat(99));
    expect(normalizeQuery(`${"a".repeat(98)}😀`)).toBe(`${"a".repeat(98)}😀`);
    expect(normalizeQuery("x \ud83d y").isWellFormed()).toBe(true);
    // Same cap on the district key (an astral letter at the cut).
    expect(districtKey(`${"a".repeat(63)}𠀀`)).toBe("a".repeat(63));
  });

  it("never rewrites numbers, models, units or prices", () => {
    for (const q of ["iphone 13", "golf 7", "clio 4", "206", "5000dh", "128go", "4g", "0612345678", "peugeot 206 2007", "a3 sportback", "ps5", "mp3", "oneplus 8t", "redmi note 8t", "oneplus 7t", "airpods 3rd", "camion 3t"]) {
      expect(normalizeQuery(q)).toBe(q);
    }
  });

  it("folds Eastern digits", () => {
    expect(normalizeQuery("طوموبيل ٢٠١٩")).toBe("طوموبيل 2019");
  });

  it("neutralises phrase quotes and exclusions", () => {
    expect(normalizeQuery('"golf 7" -diesel')).toBe("golf 7 diesel");
    expect(normalizeQuery("t-shirt")).toBe("t-shirt");
  });

  it("rewrites unknown arabizi spellings whose key one entry owns, and only those", () => {
    expect(arabiziCanonical("remor9ue")).toBe("remorque");
    expect(arabiziCanonical("7ybride")).toBe("hybride");
    expect(normalizeQuery("remor9ue agricole")).toBe("remorque agricole");
    // Known spellings stay as typed: the synonyms expand them.
    expect(arabiziCanonical("7anout")).toBeUndefined();
    expect(arabiziCanonical("bi3")).toBeUndefined();
    // Class N and P never.
    expect(arabiziCanonical("hybride")).toBeUndefined();
    expect(arabiziCanonical("golf7")).toBeUndefined();
    // No entry for the key.
    expect(arabiziCanonical("3lach")).toBeUndefined();
    expect(normalizeQuery("3lach 7out")).toBe("3lach 7out");
  });

  it("never rewrites a word that only shares consonants with an entry", () => {
    // Vowelled spellings are lexicon variants (synonyms expand them), never a skeleton match: 3ajel
    // (urgent) shares "3jl" with 3jel (vache), 7ta (until) "ht" with 7out (poisson).
    for (const q of ["3ajel", "3ajla", "3ajil", "chi9a 3ajla", "bi3 3ajel", "7ta", "7it", "7ayt", "7na", "9ana", "3omri", "7oli"]) {
      expect(normalizeQuery(q)).toBe(q);
    }
    for (const q of ["chi9a", "cha9a", "ch9a", "mou7ami", "m7ami", "iphone 13", "golf 7", "clio 4", "206", "s23u", "ps5", "5000dh", "a3", "x5", "chq"]) {
      expect(normalizeQuery(q)).toBe(q);
    }
  });

  it("replaces lexicon Arabic phrases Meilisearch misses as synonym keys", () => {
    expect(normalizeQuery("الدار البيضاء")).toBe("Casablanca");
    expect(normalizeQuery("شقة الدار البيضا")).toBe("شقة Casablanca");
    expect(normalizeQuery("فيلا القصر الكبير")).toBe("فيلا Ksar el-Kébir");
    expect(normalizeQuery("الرسم العقاري")).toBe("titre foncier");
    // Single Arabic words stay (native synonyms work for them).
    expect(normalizeQuery("شقة")).toBe("شقة");
  });

  it("has no lookup key or phrase shared by two lexicon groups", () => {
    expect(ambiguousLexiconKeys()).toEqual([]);
  });
});
