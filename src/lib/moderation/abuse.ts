import type { AbuseConfig } from "@/config/abuse";
import { compileMessageKeywords, type MessageKeywords } from "@/lib/messaging/risk";
import { compileProhibited, type CompiledProhibited } from "@/lib/moderation/prohibited";
import { riskRules, type RiskRules } from "@/lib/moderation/risk";

// Firestore `config/abuse` (src/config/abuse.ts) in the shape the detectors take: risk rules for the
// listing screen, prohibited lists and message keywords with the private extras compiled in. Pure;
// compiled once per config value (the runtime cache hands out the same object for 5 minutes). Only
// the server builds it from the stored document (src/lib/config/runtime.ts `getAbuseRules`).

export interface AbuseRules {
  risk: RiskRules;
  prohibited: CompiledProhibited;
  messaging: MessageKeywords;
}

const compiled = new WeakMap<AbuseConfig, AbuseRules>();

export function abuseRules(config: AbuseConfig): AbuseRules {
  let rules = compiled.get(config);
  if (!rules) {
    rules = { risk: riskRules(config.risk), prohibited: compileProhibited(config.prohibited), messaging: compileMessageKeywords(config.messaging) };
    compiled.set(config, rules);
  }
  return rules;
}
