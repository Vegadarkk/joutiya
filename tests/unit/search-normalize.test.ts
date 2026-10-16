import { describe, expect, it } from "vitest";
import { ambiguousLexiconKeys, ambiguousSkeletons, arabiziCanonical, arabiziSkeleton, classifyToken, foldDigits, normalizeQuery } from "@/lib/search/normalize";

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

  it("never rewrites numbers, models, units or prices", () => {
    for (const q of ["iphone 13", "golf 7", "clio 4", "206", "5000dh", "128go", "4g", "0612345678", "peugeot 206 2007", "a3 sportback", "ps5", "mp3"]) {
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

  it("matches unattested arabizi spellings through the vowel-insensitive skeleton", () => {
    expect(arabiziSkeleton("chi9a")).toBe("chq");
    expect(arabiziSkeleton("cha9a")).toBe("chq");
    expect(arabiziSkeleton("ch9a")).toBe("chq");
    expect(arabiziSkeleton("3ayla")).toBe(arabiziSkeleton("3ila"));
    expect(arabiziSkeleton("3ayla")).toBe("3l");
    expect(arabiziSkeleton("mo7ami")).toBe(arabiziSkeleton("m7ami"));
    expect(normalizeQuery("chi9a")).toBe("appartement");
    expect(normalizeQuery("cha9a f maarif")).toBe("appartement f maarif");
    expect(normalizeQuery("mou7ami")).toBe("avocat");
    expect(normalizeQuery("m7ami")).toBe("avocat");
    // Verified spellings stay as typed (synonyms); protected and plain tokens are never matched.
    expect(normalizeQuery("ch9a")).toBe("ch9a");
    for (const q of ["iphone 13", "golf 7", "clio 4", "206", "s23u", "ps5", "5000dh", "a3", "x5", "chq"]) expect(normalizeQuery(q)).toBe(q);
  });

  it("drops skeletons two entries share (no rewrite for them)", () => {
    // 7ouli (mouton) and 7li (bijoux) -> "hl"; 7mam (salle de bain) and 7mama (pigeon) -> "hm".
    expect(ambiguousSkeletons()).toEqual(["hl", "hm"]);
    expect(arabiziCanonical("7oli")).toBeUndefined();
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
