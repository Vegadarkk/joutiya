import { describe, expect, it } from "vitest";
import { LISTING_ID_PATTERN, SLUG_MAX, buildSlugId, isListingId, newListingId, parseSlugId, slugify } from "@/lib/listings/ids";

describe("newListingId", () => {
  it("returns 8 characters of the public-id alphabet, distinct across draws", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const id = newListingId();
      expect(id).toMatch(LISTING_ID_PATTERN);
      expect(id).not.toMatch(/[01ilo]/);
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });
});

describe("slugify", () => {
  it("lowercases, strips accents and keeps only letters, digits and single hyphens", () => {
    expect(slugify("Vélo électrique Décathlon, état neuf !")).toBe("velo-electrique-decathlon-etat-neuf");
    expect(slugify("  Appartement F3 -- Casablanca  ")).toBe("appartement-f3-casablanca");
    expect(slugify("iPhone 13 Pro Max 256 Go")).toBe("iphone-13-pro-max-256-go");
  });

  it("never contains a dot or a slash", () => {
    expect(slugify("v1.2 ../../etc/passwd")).toBe("v1-2-etc-passwd");
    expect(slugify("..")).toBe("");
  });

  it("transliterates Arabic titles and digits", () => {
    expect(slugify("شقة للكراء في الدار البيضاء")).toBe("chqa-llkra-fi-aldar-albida");
    expect(slugify("هاتف ٢٥٦ جيغا")).toBe("hatf-256-jigha");
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("🚗🚗")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("cuts at a hyphen under the maximum length", () => {
    const long = Array.from({ length: 30 }, (_, i) => `mot${i}`).join(" ");
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.split("-").every((part) => /^mot\d+$/.test(part))).toBe(true);
    // A single long word is cut hard.
    expect(slugify("a".repeat(100))).toBe("a".repeat(SLUG_MAX));
  });
});

describe("buildSlugId / parseSlugId", () => {
  const id = "abcdefgh";

  it("builds `{title-city}-{id}` and parses it back", () => {
    const slugId = buildSlugId({ id, title: "Vélo électrique", city: "Casablanca", categoryId: "velos" });
    expect(slugId).toBe("velo-electrique-casablanca-abcdefgh");
    expect(parseSlugId(slugId)).toEqual({ id, slug: "velo-electrique-casablanca" });
  });

  it("falls back to the category id, then to a constant, when the title gives no ASCII", () => {
    expect(buildSlugId({ id, title: "🚗", categoryId: "vehicules" })).toBe(`vehicules-${id}`);
    expect(buildSlugId({ id, title: "🚗" })).toBe(`annonce-${id}`);
    expect(buildSlugId({ id, title: "", city: "Fès" })).toBe(`fes-${id}`);
  });

  it("refuses an invalid id", () => {
    expect(() => buildSlugId({ id: "ABCDEFGH", title: "x" })).toThrow(RangeError);
    expect(() => buildSlugId({ id: "abc", title: "x" })).toThrow(RangeError);
    expect(isListingId("abcdefg1")).toBe(false);
    expect(isListingId("abcdefg2")).toBe(true);
  });

  it("accepts a bare id and a wrong slug, refuses anything without a readable id", () => {
    expect(parseSlugId(id)).toEqual({ id, slug: "" });
    expect(parseSlugId(`autre-titre-${id}`)).toEqual({ id, slug: "autre-titre" });
    expect(parseSlugId(`x${id}`)).toBeNull();
    expect(parseSlugId("abcdefg")).toBeNull();
    expect(parseSlugId("slug-ABCDEFGH")).toBeNull();
    expect(parseSlugId("slug-abcdefg0")).toBeNull();
    expect(parseSlugId(`${"a".repeat(200)}-${id}`)).toBeNull();
    expect(parseSlugId(`x.1-${id}`)).toBeNull();
    expect(parseSlugId(`v%C3%A9lo-${id}`)).toBeNull();
  });
});
