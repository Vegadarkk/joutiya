import { describe, expect, it } from "vitest";
import { mergeEnvFile, planKeys, SEARCH_KEYS } from "../../scripts/search-setup";

describe("search-setup", () => {
  it("declares the two app keys of D3 with fixed uuid uids", () => {
    expect(SEARCH_KEYS.map((key) => key.envName)).toEqual(["MEILI_SEARCH_KEY", "MEILI_INDEX_KEY"]);
    for (const key of SEARCH_KEYS) {
      expect(key.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(key.indexes).toEqual(["listings_*"]);
    }
    expect(SEARCH_KEYS[0]?.actions).toEqual(["search", "documents.get"]);
    expect(SEARCH_KEYS[1]?.actions).toEqual(["documents.*", "indexes.*", "settings.*", "tasks.get", "stats.get"]);
  });

  it("plans creation, reuse or recreation of each key", () => {
    const [search, index] = SEARCH_KEYS;
    if (!search || !index) throw new Error("keys");
    expect(planKeys([]).map((step) => step.action)).toEqual(["create", "create"]);
    const plan = planKeys([
      { uid: search.uid, actions: [...search.actions].reverse(), indexes: ["listings_*"] },
      { uid: index.uid, actions: ["*"], indexes: ["*"] },
      { uid: "other", actions: ["*"], indexes: ["*"] },
    ]);
    expect(plan.map((step) => step.action)).toEqual(["keep", "recreate"]);
  });

  it("sets key lines in an env file and keeps the others", () => {
    expect(mergeEnvFile("", { MEILI_SEARCH_KEY: "s" })).toBe("MEILI_SEARCH_KEY=s\n");
    expect(mergeEnvFile("A=1\nMEILI_SEARCH_KEY=old\n# note\n", { MEILI_SEARCH_KEY: "s", MEILI_INDEX_KEY: "i" })).toBe("A=1\nMEILI_SEARCH_KEY=s\n# note\nMEILI_INDEX_KEY=i\n");
  });
});
