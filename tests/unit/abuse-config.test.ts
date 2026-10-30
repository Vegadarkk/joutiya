import { describe, expect, it } from "vitest";
import { DEFAULT_ABUSE, OVERRIDABLE_RATE_LIMIT_IDS, RISK_FLAG_IDS, abuseConfigSchema, resolveAbuseConfig, type AbuseConfig } from "@/config/abuse";
import { DEFAULT_AI } from "@/config/ai";
import { MODERATION_FLAGS } from "@/lib/contracts/listings";
import { analyzeMessage } from "@/lib/messaging/risk";
import { abuseRules } from "@/lib/moderation/abuse";
import { screenFreeText } from "@/lib/moderation/free-text";
import { containsProhibited } from "@/lib/moderation/prohibited";
import { DEFAULT_RISK_RULES, NEW_ACCOUNT_DAYS, PREVIOUS_REJECTION_CAP, PREVIOUS_REJECTION_WEIGHT, RISK_WEIGHTS, VOLUME_PER_DAY, riskScore } from "@/lib/moderation/risk";
import { screenListing } from "@/lib/moderation/screen";
import type { ScreenInput } from "@/lib/moderation/types";
import { checkSocialLink } from "@/lib/pro/social-links-rules";
import { insideRepository, planAbuse } from "../../scripts/abuse-config";

// config/abuse (spec §10): private overrides of the anti-abuse values, whose committed defaults are
// public. Defaults equal the committed values; overrides reach the listing screen, the prohibited
// lists, the free-text and social-link screens and the message keywords.

const config = (patch: Partial<AbuseConfig>): AbuseConfig => ({ ...DEFAULT_ABUSE, ...patch });

function listing(overrides: Partial<ScreenInput> = {}): ScreenInput {
  return {
    title: "Dacia Logan 2019 diesel",
    description: "Logan 1.5 dCi, 85 000 km, entretien chez le concessionnaire, carnet à jour, 2 clés. Prix 95 000 DH négociable.",
    attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" },
    categoryId: "vehicules",
    subcategoryId: "voitures",
    price: 95_000,
    isDonation: false,
    contact: { showPhone: true, whatsapp: true },
    sensitiveDeclaration: null,
    photos: [{ checks: { nsfw: 0.02, faces: 0 } }],
    seller: { accountAgeDays: 30, listingsLast24h: 0, phoneVerified: true, previousRejections: 0 },
    duplicates: { sameText: 0, samePhoto: 0 },
    ...overrides,
  };
}

describe("config/abuse defaults", () => {
  it("equal the committed values, so an absent document changes nothing", () => {
    expect(abuseConfigSchema.safeParse(DEFAULT_ABUSE).success).toBe(true);
    expect(DEFAULT_ABUSE).toEqual({
      risk: { newAccountDays: 1, volumePerDay: 3, weights: {}, previousRejectionWeight: 10, previousRejectionCap: 30 },
      prohibited: {},
      messaging: { paymentKeywords: [], contactAppKeywords: [] },
      rateLimits: {},
    });
    expect([NEW_ACCOUNT_DAYS, VOLUME_PER_DAY, PREVIOUS_REJECTION_WEIGHT, PREVIOUS_REJECTION_CAP]).toEqual([1, 3, 10, 30]);
    for (const flag of MODERATION_FLAGS) expect(DEFAULT_RISK_RULES.weights[flag]).toBe(RISK_WEIGHTS[flag].weight);
    expect(abuseRules(DEFAULT_ABUSE).risk).toEqual(DEFAULT_RISK_RULES);
  });

  it("names every moderation flag (the script cannot import the contracts)", () => {
    expect([...RISK_FLAG_IDS]).toEqual([...MODERATION_FLAGS]);
  });

  it("compiles once per config value", () => {
    const value = config({});
    expect(abuseRules(value)).toBe(abuseRules(value));
  });
});

describe("resolveAbuseConfig", () => {
  it("returns the defaults for an absent document", () => {
    expect(resolveAbuseConfig(undefined)).toEqual({ config: DEFAULT_ABUSE, errors: [] });
    expect(resolveAbuseConfig(null).config).toBe(DEFAULT_ABUSE);
    expect(resolveAbuseConfig("on")).toEqual({ config: DEFAULT_ABUSE, errors: ["config/abuse: not an object"] });
  });

  it("merges a partial section over its defaults and ignores the editing metadata", () => {
    const { config: resolved, errors } = resolveAbuseConfig({ risk: { volumePerDay: 6, weights: { volume: 40 } }, messaging: { paymentKeywords: ["kash"] }, updatedAt: new Date(), updatedBy: "uid-admin" });
    expect(errors).toEqual([]);
    expect(resolved.risk).toEqual({ ...DEFAULT_ABUSE.risk, volumePerDay: 6, weights: { volume: 40 } });
    expect(resolved.messaging).toEqual({ paymentKeywords: ["kash"], contactAppKeywords: [] });
  });

  it("keeps the valid fields and entries when another one is wrong, and reports each error", () => {
    const { config: resolved, errors } = resolveAbuseConfig({
      risk: { newAccountDays: 7, volumePerDay: 0, weights: { not_a_flag: 10 } },
      prohibited: { drugs: { hard: ["zorglub"] }, spells: { hard: ["x"] }, weapons: { hard: "glaive" } },
      rateLimits: { "signup.ip": { points: 10 }, "pages.ip": { points: 1 }, "nope.id": { points: 1 }, "login.ip": { points: -1 } },
      extra: true,
    });
    expect(resolved.risk).toEqual({ ...DEFAULT_ABUSE.risk, newAccountDays: 7 });
    expect(resolved.prohibited).toEqual({ drugs: { hard: ["zorglub"] } });
    expect(resolved.rateLimits).toEqual({ "signup.ip": { points: 10 } });
    expect(errors.map((error) => error.split(":")[0])).toEqual([
      "risk.volumePerDay",
      "risk.weights",
      "prohibited.spells",
      "prohibited.weapons",
      "rateLimits.pages.ip",
      "rateLimits.nope.id",
      "rateLimits.login.ip",
      "extra",
    ]);
  });

  it("leaves the proxy's page limits out of the overridable ids", () => {
    expect(OVERRIDABLE_RATE_LIMIT_IDS.some((id) => id.startsWith("pages."))).toBe(false);
    expect(OVERRIDABLE_RATE_LIMIT_IDS).toContain("signup.device");
  });

  it("trims terms and refuses blank or one-letter ones", () => {
    expect(resolveAbuseConfig({ messaging: { contactAppKeywords: ["  signal  "] } }).config.messaging.contactAppKeywords).toEqual(["signal"]);
    expect(resolveAbuseConfig({ messaging: { contactAppKeywords: ["x"] } }).errors).toHaveLength(1);
  });
});

describe("risk overrides in the listing screen", () => {
  const ctx = (patch: Partial<AbuseConfig>) => ({ ai: DEFAULT_AI, abuse: abuseRules(config(patch)) });

  it("applies the committed thresholds without config/abuse", () => {
    const result = screenListing(listing({ seller: { accountAgeDays: 0, listingsLast24h: 3, phoneVerified: true, previousRejections: 0 } }), { ai: DEFAULT_AI });
    expect(result.flags).toEqual(["new_account", "volume"]);
    expect(result.score).toBe(30);
  });

  it("raises new_account and volume at the configured thresholds", () => {
    const seller = { accountAgeDays: 3, listingsLast24h: 3, phoneVerified: true, previousRejections: 0 };
    expect(screenListing(listing({ seller }), { ai: DEFAULT_AI }).flags).toEqual(["volume"]);
    const result = screenListing(listing({ seller }), ctx({ risk: { ...DEFAULT_ABUSE.risk, newAccountDays: 7, volumePerDay: 5 } }));
    expect(result.flags).toEqual(["new_account"]);
    expect(result.evidence).toContain("account age 3 day(s)");
  });

  it("scores with the configured weights and rejection terms, and can send a listing to review", () => {
    const seller = { accountAgeDays: 0, listingsLast24h: 0, phoneVerified: true, previousRejections: 2 };
    expect(screenListing(listing({ seller }), { ai: DEFAULT_AI })).toMatchObject({ state: "auto_ok", score: 35 });
    const result = screenListing(listing({ seller }), ctx({ risk: { ...DEFAULT_ABUSE.risk, weights: { new_account: 40 }, previousRejectionWeight: 15, previousRejectionCap: 20 } }));
    expect(result).toMatchObject({ state: "needs_review", score: 60, flags: ["new_account"] });
    expect(riskScore(["new_account"], {}, abuseRules(config({ risk: { ...DEFAULT_ABUSE.risk, weights: { new_account: 0 } } })).risk).score).toBe(0);
  });

  it("blocks an extra hard term and holds an extra soft term", () => {
    const abuse = ctx({ prohibited: { drugs: { hard: ["zorglub"] }, counterfeit: { soft: ["replique premium"] } } });
    const hard = listing({ description: "Livraison de zorglub dans tout le Maroc, discrétion assurée, paiement à la livraison." });
    expect(screenListing(hard, { ai: DEFAULT_AI }).blockers).toEqual([]);
    const blocked = screenListing(hard, abuse);
    expect(blocked.blockers).toEqual([{ path: "description", code: "prohibited" }]);
    expect(blocked.flags).toContain("prohibited_kw");
    const soft = screenListing(listing({ title: "Montre réplique premium neuve" }), abuse);
    expect(soft).toMatchObject({ state: "needs_review", blockers: [] });
    expect(soft.flags).toContain("prohibited_soft");
    // Evidence names the group, never the private term.
    expect([...blocked.evidence, ...soft.evidence].join(" ")).not.toMatch(/zorglub|replique/);
  });
});

describe("extra terms in the other screens", () => {
  const rules = abuseRules(config({ prohibited: { drugs: { hard: ["zorglub"], soft: ["herbe magique"] } }, messaging: { paymentKeywords: ["kash rapide"], contactAppKeywords: ["signal"] } }));

  it("adds the extra prohibited terms to the committed groups, in group order", () => {
    expect(containsProhibited("vends zorglub").hard).toEqual([]);
    expect(containsProhibited("vends zorglub", rules.prohibited)).toMatchObject({ hard: ["drugs"], soft: [] });
    expect(containsProhibited("de l'herbe magique", rules.prohibited)).toMatchObject({ hard: [], soft: ["drugs"] });
    // The committed lists still apply.
    expect(containsProhibited("kalachnikov a vendre", rules.prohibited).hard).toEqual(["weapons"]);
  });

  it("refuses an extra hard term in a free text and a social handle on the server only", () => {
    expect(screenFreeText("Spécialiste du zorglub").blockers).toEqual([]);
    expect(screenFreeText("Spécialiste du zorglub", rules.prohibited).blockers).toEqual(["prohibited"]);
    expect(checkSocialLink("instagram", "zorglub.shop")).toEqual({ handle: "zorglub.shop" });
    expect(checkSocialLink("instagram", "zorglub.shop", rules.prohibited)).toEqual({ problem: "prohibited" });
  });

  it("flags a message on the extra payment and contact-app keywords", () => {
    expect(analyzeMessage("Kash rapide avant la visite, on parle sur Signal").flags).toEqual([]);
    expect(analyzeMessage("Kash rapide avant la visite, on parle sur Signal", rules.messaging).flags).toEqual(["payment_kw", "contact_with_payment_kw"]);
    expect(analyzeMessage("Acompte demandé, écris-moi sur Signal", rules.messaging).flags).toEqual(["payment_kw", "contact_with_payment_kw"]);
  });
});

describe("scripts/abuse-config.ts", () => {
  it("plans the document without printing a term", () => {
    const plan = planAbuse({ risk: { volumePerDay: 5 }, prohibited: { drugs: { hard: ["zorglub"] } }, messaging: { paymentKeywords: ["kash rapide"] }, rateLimits: { "signup.ip": { points: 10 } } });
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toEqual([
      "risk: newAccountDays=1, volumePerDay=5, previousRejectionWeight=10, previousRejectionCap=30",
      "prohibited drugs: +1 hard, +0 soft",
      "messaging: +1 payment, +0 contact-app keywords",
      'rate limit signup.ip: {"points":10}',
    ]);
    expect(plan.summary.join(" ")).not.toMatch(/zorglub|kash/);
    expect(planAbuse([]).errors).toEqual(["the file must hold a JSON object"]);
    expect(planAbuse({ risk: { volumePerDay: "5" } }).errors).toHaveLength(1);
  });

  it("refuses a file inside the repository", () => {
    expect(insideRepository("/repo/infra/abuse.json", "/repo")).toBe(true);
    expect(insideRepository("/repo", "/repo")).toBe(true);
    expect(insideRepository("/home/owner/.joutiya/abuse-prod.json", "/repo")).toBe(false);
    expect(insideRepository("/repo-private/abuse.json", "/repo")).toBe(false);
  });
});
