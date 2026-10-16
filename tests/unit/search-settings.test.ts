import { describe, expect, it } from "vitest";
import { CRITERIA } from "@/config/categories";
import { cityBySlug } from "@/config/regions";
import { CITY_LEXICON, DARIJA_LEXICON, entrySpellings } from "@/config/search/darija";
import { SEARCH_MAX_TOTAL_HITS } from "@/lib/search/params";
import {
  COMPARISON_FILTERS,
  EQUALITY_FILTERS,
  filterKind,
  isGuardedSpelling,
  MAX_SYNONYMS_PER_TERM,
  SEARCH_SETTINGS,
  SEARCH_SYNONYMS,
  settingsDiff,
  synonymGroups,
  synonymKey,
} from "@/lib/search/settings";
import { attributeField, CARD_FIELDS } from "@/lib/search/types";

describe("SEARCH_SETTINGS", () => {
  it("follows D4", () => {
    expect(SEARCH_SETTINGS.searchableAttributes).toEqual(["title", "categoryText", "attrsText", "placeText", "description"]);
    expect(SEARCH_SETTINGS.sortableAttributes).toEqual(["sortAt", "price", "_geo"]);
    expect(SEARCH_SETTINGS.rankingRules.slice(0, 2)).toEqual(["words", "sort"]);
    expect(SEARCH_SETTINGS.rankingRules.at(-1)).toBe("sortAt:desc");
    expect(SEARCH_SETTINGS.pagination.maxTotalHits).toBe(SEARCH_MAX_TOTAL_HITS);
    expect(SEARCH_SETTINGS.pagination.maxTotalHits).toBe(1200);
    expect(SEARCH_SETTINGS.typoTolerance.disableOnNumbers).toBe(true);
    expect(SEARCH_SETTINGS.localizedAttributes).toEqual([{ attributePatterns: [...SEARCH_SETTINGS.searchableAttributes], locales: ["fra", "ara"] }]);
    expect(SEARCH_SETTINGS.stopWords).toEqual(["ال", "أل", "إل", "آل", "ٱل"]);
    expect(SEARCH_SETTINGS.searchCutoffMs).toBe(500);
  });

  it("makes every D4 field and every non-text criterion filterable, nothing private", () => {
    for (const field of ["categoryId", "subcategoryId", "regionCode", "citySlug", "district", "sellerType", "sellerPublicId", "isDonation", "hasPhoto", "condition", "id", "sitemapShard"]) {
      expect(filterKind(field)).toBe("equality");
    }
    for (const field of ["price", "sortAt", "featuredUntil"]) expect(filterKind(field)).toBe("comparison");
    expect(filterKind("_geo")).toBe("geo");
    for (const criterion of Object.values(CRITERIA)) {
      const kind = filterKind(attributeField(criterion.id));
      if (criterion.type === "text") expect(kind).toBeUndefined();
      else if (criterion.type === "number") expect(kind).toBe("comparison");
      else expect(kind).toBe("equality");
    }
    for (const field of ["ownerUid", "proId", "title", "description", "version"]) expect(filterKind(field)).toBeUndefined();
    expect(new Set([...EQUALITY_FILTERS, ...COMPARISON_FILTERS]).size).toBe(EQUALITY_FILTERS.length + COMPARISON_FILTERS.length);
  });

  it("can facet every card field a filter needs", () => {
    for (const field of ["citySlug", "subcategoryId", "sellerType", "isDonation"]) expect(CARD_FIELDS).toContain(field);
  });
});

describe("synonyms", () => {
  it("respects Meilisearch limits", () => {
    for (const [term, others] of Object.entries(SEARCH_SYNONYMS)) {
      expect(others.length, term).toBeLessThanOrEqual(MAX_SYNONYMS_PER_TERM);
      expect(term.split(" ").length, term).toBeLessThanOrEqual(3);
      expect(others, term).not.toContain(term);
    }
    expect(Math.max(...synonymGroups().map((group) => group.length))).toBeLessThanOrEqual(MAX_SYNONYMS_PER_TERM);
  });

  it("puts each folded spelling in one group only", () => {
    const owner = new Map<string, number>();
    synonymGroups().forEach((group, index) => {
      for (const spelling of group) {
        const key = synonymKey(spelling);
        expect(owner.get(key) ?? index, `${spelling} is in two groups`).toBe(index);
        owner.set(key, index);
      }
    });
  });

  it("is mutual within a group", () => {
    // Research candidates stay out until reviewed ("chqa"); reviewed ones join their group.
    expect(SEARCH_SYNONYMS["chqa"]).toBeUndefined();
    expect(SEARCH_SYNONYMS["chi9a"]).toEqual(expect.arrayContaining(["appartement", "ch9a", "شقة"]));
    const vendre = SEARCH_SYNONYMS["vendre"] ?? [];
    expect(vendre).toEqual(expect.arrayContaining(["bi3", "للبيع"]));
    expect(SEARCH_SYNONYMS["bi3"]).toEqual(expect.arrayContaining(["vendre"]));
    expect(SEARCH_SYNONYMS["casa"]).toEqual(expect.arrayContaining(["casablanca", "الدار البيضاء"]));
    expect(SEARCH_SYNONYMS["kra"]).toEqual(expect.arrayContaining(["louer"]));
  });

  it("adds the ك ف ب spellings Meilisearch does not fold", () => {
    const regional = Object.keys(SEARCH_SYNONYMS).filter((term) => /[ڭݣگڤپ]/.test(term));
    expect(regional.length).toBeGreaterThan(0);
    for (const term of regional) {
      const plain = term.replace(/[ڭݣگ]/g, "ك").replace(/ڤ/g, "ف").replace(/پ/g, "ب");
      expect(SEARCH_SYNONYMS[term], term).toContain(plain);
    }
  });

  it("keeps place-name words and guarded spellings out", () => {
    for (const spelling of ["dar", "دار", "جديدة", "meublé"]) {
      expect(isGuardedSpelling(spelling)).toBe(true);
      expect(SEARCH_SYNONYMS[spelling]).toBeUndefined();
    }
    expect(SEARCH_SYNONYMS["maison"]).toEqual(expect.arrayContaining(["منزل"]));
    expect(SEARCH_SYNONYMS["maison"]).not.toContain("dar");
    expect(SEARCH_SYNONYMS["neuf"]).not.toContain("جديدة");
    expect(SEARCH_SYNONYMS["el jadida"] ?? []).not.toContain("jdida");
    expect(SEARCH_SYNONYMS["auto"]).toBeUndefined();
  });

  it("only exports verified data with known city slugs", () => {
    expect(DARIJA_LEXICON.length).toBeGreaterThan(300);
    for (const city of CITY_LEXICON) expect(cityBySlug(city.slug), city.slug).toBeDefined();
    for (const entry of DARIJA_LEXICON) expect(entrySpellings(entry).length, entry.canonical).toBeGreaterThan(1);
    expect(DARIJA_LEXICON.find((entry) => entry.canonical === "louer")?.variants).toContain("kra");
    expect(DARIJA_LEXICON.flatMap(entrySpellings)).not.toContain("auto");
  });
});

describe("settingsDiff", () => {
  const live = () => JSON.parse(JSON.stringify(SEARCH_SETTINGS)) as Record<string, unknown>;

  it("is empty for the same settings, whatever the order Meilisearch returns unordered lists in", () => {
    const current = live();
    current.sortableAttributes = ["_geo", "price", "sortAt"];
    current.stopWords = [...SEARCH_SETTINGS.stopWords].reverse();
    current.synonyms = Object.fromEntries(Object.entries(SEARCH_SETTINGS.synonyms).reverse().map(([k, v]) => [k, [...v].reverse()]));
    // Extra keys and defaults Meilisearch adds do not count.
    current.embedders = {};
    current.typoTolerance = { ...SEARCH_SETTINGS.typoTolerance, extra: true };
    expect(settingsDiff(current)).toEqual([]);
  });

  it("names the settings that differ", () => {
    const current = live();
    current.rankingRules = ["words", "typo", "proximity", "attributeRank", "sort", "wordPosition", "exactness"];
    current.pagination = { maxTotalHits: 1000 };
    (current.synonyms as Record<string, string[]>).extra = ["x"];
    delete current.localizedAttributes;
    expect(settingsDiff(current).sort()).toEqual(["localizedAttributes", "pagination", "rankingRules", "synonyms"]);
    expect(settingsDiff(null)).toEqual(Object.keys(SEARCH_SETTINGS));
  });
});
