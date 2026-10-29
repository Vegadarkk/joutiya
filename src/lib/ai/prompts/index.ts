import "server-only";
import { createHash } from "node:crypto";
import { AI_TASKS, type AiTask } from "../types";
import { PLATFORM_RULES } from "./shared";

// Versioned system prompts (design D19). The version stored on every aiDecision is
// `{task}.v{PROMPT_GENERATION}.{8 hex of sha256(systemPrompt)}`: the hash follows every change of
// PLATFORM_RULES or of a task text (a report-reason label included), so a stored proposal is tied
// to the exact prompt that produced it (audit D1b-11); the generation is bumped by hand when the
// meaning of a task changes (v2: user fields in tags + untrusted-content rule, audit D1b-03). The
// user content (masked) goes in the user turn.

export const PROMPT_GENERATION = 2;

const LISTING_SCREEN = `Task: screen one classified listing (title, description, category, price, city and up to three photos labelled "Image 1:", "Image 2:", ...).

Answer with one action:
- "approve": the listing complies with the rules; confidence 0.9 or more only when nothing at all is doubtful.
- "hold": a human moderator must review it (possible prohibited item, possible scam, photos that do not match the text, personal data of a third party, sexual content).
- "reject": a clear violation of the rules. Use policy "spam" with a high confidence only for obvious spam (repeated advertisement, no real item, advertising for another site).
- "escalate": you cannot tell (language you do not understand, unreadable photos, missing context).
Set "policy" to the report reason that applies to a listing, or "none" when you approve. "templateId" stays empty.`;

const REPORT_TRIAGE = `Task: triage one report (notice) sent to Aalan about a listing, a user profile, a private message or a buyer's review of a seller. You receive the report reason chosen by the reporter, the reporter's explanation and the reported content (masked). Reporters can be wrong or abusive: judge the content, not the reporter's tone.

Answer with one action:
- "reject": the report looks founded and the content should be removed or restricted.
- "hold": the report looks founded but the sanction needs a human choice (account history, severity).
- "approve": the content looks compliant: the report looks unfounded and could be dismissed.
- "escalate": you cannot tell.
A review must describe the buyer's own exchange with the seller: a negative opinion is allowed; insults, personal or sensitive data, advertising and text unrelated to the exchange are not. A review held by the platform before publication (origin "règle automatique") was flagged for possible sensitive data: "approve" means it can be published as is.
Set "policy" to the report reason that really applies (it may differ from the reporter's choice), "severity" to its priority, and "templateId" to a short snake_case decision template suggestion (for example "listing_remove_scam") or leave it empty. "userMessage" is a draft statement of reasons for the affected user when you propose a measure.`;

const APPEAL_REVIEW = `Task: review one appeal (internal complaint, art. 20 DSA) against a moderation decision. You receive the decision (measure, facts, ground) and the appellant's text (masked), and the content concerned when it still exists. Appellants are often upset: judge the facts and the rules, not the tone.

Answer with one action:
- "approve": the appeal looks founded: the decision should be reversed (content restored, sanction lifted or reduced).
- "reject": the appeal looks unfounded: the decision should be upheld.
- "escalate": you cannot tell, or the appeal raises facts a human must check (identity, ownership, documents).
Set "policy" to the reason the decision relied on, "severity" to its priority, "templateId" empty. "userMessage" is a draft answer to the appellant explaining the outcome you propose, without promising it: a human reviewer decides.`;

const TASK_TEXT: Record<AiTask, string> = {
  listing_screen: LISTING_SCREEN,
  report_triage: REPORT_TRIAGE,
  appeal_review: APPEAL_REVIEW,
};

/** The cached system prompt of a task: platform rules first (shared prefix), then the task. */
export function systemPrompt(task: AiTask): string {
  return `${PLATFORM_RULES}\n\n${TASK_TEXT[task]}`;
}

/** `{task}.v{generation}.{sha256 prefix}` of the system prompt text (<= 40 characters, aiDecisions.promptVersion). */
export function promptVersion(task: AiTask): string {
  return `${task}.v${PROMPT_GENERATION}.${createHash("sha256").update(systemPrompt(task)).digest("hex").slice(0, 8)}`;
}

export const PROMPT_VERSIONS: Record<AiTask, string> = Object.fromEntries(AI_TASKS.map((task) => [task, promptVersion(task)])) as Record<AiTask, string>;
