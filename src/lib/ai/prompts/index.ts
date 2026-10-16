import "server-only";
import type { AiTask } from "../types";
import { PLATFORM_RULES } from "./shared";

// Versioned system prompts (design D19). The version is stored on every aiDecision: bump it with
// any change of PLATFORM_RULES or of a task text. The user content (masked) goes in the user turn.

export const PROMPT_VERSIONS: Record<AiTask, string> = {
  listing_screen: "listing_screen.v1",
  report_triage: "report_triage.v1",
  appeal_review: "appeal_review.v1",
};

const LISTING_SCREEN = `Task: screen one classified listing (title, description, category, price, city and up to three photos labelled "Image 1:", "Image 2:", ...).

Answer with one action:
- "approve": the listing complies with the rules; confidence 0.9 or more only when nothing at all is doubtful.
- "hold": a human moderator must review it (possible prohibited item, possible scam, photos that do not match the text, personal data of a third party, sexual content).
- "reject": a clear violation of the rules. Use policy "spam" with a high confidence only for obvious spam (repeated advertisement, no real item, advertising for another site).
- "escalate": you cannot tell (language you do not understand, unreadable photos, missing context).
Set "policy" to the report reason that applies to a listing, or "none" when you approve. "templateId" stays empty.`;

const REPORT_TRIAGE = `Task: triage one report (notice) sent to Joutiya about a listing, a user profile or a private message. You receive the report reason chosen by the reporter, the reporter's explanation and the reported content (masked). Reporters can be wrong or abusive: judge the content, not the reporter's tone.

Answer with one action:
- "reject": the report looks founded and the content should be removed or restricted.
- "hold": the report looks founded but the sanction needs a human choice (account history, severity).
- "approve": the content looks compliant: the report looks unfounded and could be dismissed.
- "escalate": you cannot tell.
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
