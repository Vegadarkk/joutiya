import type { ProhibitedExtraTerms } from "@/config/abuse";
import { PROHIBITED_GROUPS, type ProhibitedGroupId } from "@/config/prohibited";
import { TokenizedText, compileKeywords, type CompiledKeyword } from "@/lib/moderation/keywords";

// Prohibited objects (architecture §7 step 2). Lists in src/config/prohibited.ts; matching rules in
// src/lib/moderation/keywords.ts. Pure, client-safe. The server adds the private terms of Firestore
// `config/abuse` (compileProhibited, passed as `terms`); the browser only ever has the committed lists.

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

/** The committed lists plus extra terms, compiled (compileProhibited). */
export interface CompiledProhibited {
  readonly groups: readonly CompiledGroup[];
}

let compiled: CompiledProhibited | undefined;

function committedTerms(): CompiledProhibited {
  compiled ??= compileProhibited({});
  return compiled;
}

/** The committed groups with `extra` terms appended (config order kept); compile once per config value. */
export function compileProhibited(extra: ProhibitedExtraTerms): CompiledProhibited {
  return {
    groups: PROHIBITED_GROUPS.map((group) => ({
      id: group.id,
      hard: compileKeywords([...group.hard, ...(extra[group.id]?.hard ?? [])]),
      soft: compileKeywords([...group.soft, ...(extra[group.id]?.soft ?? [])]),
    })),
  };
}

/** Hard and soft prohibited groups mentioned in a text; `terms`: the server's compiled config/abuse lists (default: the committed ones). */
export function containsProhibited(text: string, terms: CompiledProhibited = committedTerms()): ProhibitedResult {
  const result: ProhibitedResult = { hard: [], soft: [], matches: [] };
  if (!text) return result;
  const tokens = new TokenizedText(text);
  for (const group of terms.groups) {
    const hardHits = tokens.find(group.hard);
    const softHits = tokens.find(group.soft);
    for (const hit of hardHits) result.matches.push({ group: group.id, level: "hard", term: hit.term });
    for (const hit of softHits) result.matches.push({ group: group.id, level: "soft", term: hit.term });
    if (hardHits.length > 0) result.hard.push(group.id);
    else if (softHits.length > 0) result.soft.push(group.id);
  }
  return result;
}
