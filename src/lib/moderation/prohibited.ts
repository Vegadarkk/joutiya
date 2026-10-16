import { PROHIBITED_GROUPS, type ProhibitedGroupId } from "@/config/prohibited";
import { TokenizedText, compileKeywords, type CompiledKeyword } from "@/lib/moderation/keywords";

// Prohibited objects (architecture §7 step 2). Lists in src/config/prohibited.ts; matching rules in
// src/lib/moderation/keywords.ts. Pure, client-safe.

export type ProhibitedLevel = "hard" | "soft";

export interface ProhibitedMatch {
  group: ProhibitedGroupId;
  level: ProhibitedLevel;
  /** Term of the config that matched (not the text as written). */
  term: string;
}

export interface ProhibitedResult {
  /** Group ids with a hard hit, in config order. */
  hard: ProhibitedGroupId[];
  /** Group ids with a soft hit and no hard hit, in config order. */
  soft: ProhibitedGroupId[];
  matches: ProhibitedMatch[];
}

interface CompiledGroup {
  id: ProhibitedGroupId;
  hard: CompiledKeyword[];
  soft: CompiledKeyword[];
}

let compiled: CompiledGroup[] | undefined;

function groups(): CompiledGroup[] {
  compiled ??= PROHIBITED_GROUPS.map((group) => ({ id: group.id, hard: compileKeywords(group.hard), soft: compileKeywords(group.soft) }));
  return compiled;
}

/** Hard and soft prohibited groups mentioned in a text. */
export function containsProhibited(text: string): ProhibitedResult {
  const result: ProhibitedResult = { hard: [], soft: [], matches: [] };
  if (!text) return result;
  const tokens = new TokenizedText(text);
  for (const group of groups()) {
    const hardHits = tokens.find(group.hard);
    const softHits = tokens.find(group.soft);
    for (const hit of hardHits) result.matches.push({ group: group.id, level: "hard", term: hit.term });
    for (const hit of softHits) result.matches.push({ group: group.id, level: "soft", term: hit.term });
    if (hardHits.length > 0) result.hard.push(group.id);
    else if (softHits.length > 0) result.soft.push(group.id);
  }
  return result;
}
