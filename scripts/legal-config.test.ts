import assert from "node:assert/strict";
import { test } from "node:test";
import { planLegal } from "./legal-config.ts";

// Runs under plain Node (no `@/` alias), as the script does on the owner's machine.
test("plans config/legal from a JSON object and lists the missing mentions", () => {
  assert.deepEqual(planLegal([]).errors, ["the file must hold a JSON object"]);
  assert.deepEqual(planLegal({}), { config: planLegal({}).config, errors: [], missing: [] });
  assert.deepEqual(planLegal({ phone: "" }).missing, ["phone"]);
});
