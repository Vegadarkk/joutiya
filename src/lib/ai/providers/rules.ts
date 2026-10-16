import "server-only";
import { asPolicy, escalation } from "../output";
import type { AiOutput, AiProvider, AiTaskInput, ProviderResult } from "../types";

// Last fallback (design D19): deterministic, always available, free. It only restates what the
// local pre-moderation and the report already say, and always leaves the decision to a human:
// a hard prohibited term or a moderation flag proposes a hold, anything else is an escalation
// with no signal. Never an approval or a rejection.

export const RULES_MODEL = "rules.v1";

export function rulesOutput(input: AiTaskInput): AiOutput {
  const facts = input.facts;
  switch (facts.kind) {
    case "listing": {
      if (facts.prohibitedHard.length > 0) {
        return {
          action: "hold",
          policy: "illegal_item",
          severity: "P1",
          confidence: 0.5,
          rationale: `Règles locales : vocabulaire interdit (${facts.prohibitedHard.join(", ")}). À vérifier par un modérateur.`,
        };
      }
      if (facts.flags.length > 0) return escalation(`Règles locales : signaux de la pré-modération (${facts.flags.join(", ")}) ; un modérateur décide.`);
      return escalation("Règles locales : aucun signal ; analyse automatique indisponible, un modérateur décide.");
    }
    case "report":
      return escalation("Règles locales : tri automatique indisponible ; priorité du motif conservée.", facts.priority, asPolicy(facts.reasonId));
    case "appeal":
      return escalation("Règles locales : analyse automatique du recours indisponible ; un autre modérateur décide.");
  }
}

export function createRulesProvider(): AiProvider {
  return {
    id: "rules",
    async available() {
      return true;
    },
    async run(input: AiTaskInput): Promise<ProviderResult> {
      return { output: rulesOutput(input), model: RULES_MODEL, costMicroUsd: 0 };
    },
  };
}
