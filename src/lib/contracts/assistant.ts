import { LOCALES } from "@/config/site";
import { z } from "@/lib/zod";
import { ASSISTANT_HISTORY_MAX, ASSISTANT_QUESTION_MAX, ASSISTANT_TURN_MAX } from "./endpoints";

// POST /api/assistant (design phase-5 D25): a question to the Assistant Joutiya, with the last
// turns of the conversation kept by the widget (never stored server side). Client-safe.

export { ASSISTANT_HISTORY_MAX, ASSISTANT_QUESTION_MAX, ASSISTANT_TURN_MAX };

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // No control characters except line breaks.
    .refine((value) => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(value), { message: "control characters" });

export const assistantRequestSchema = z
  .object({
    locale: z.enum(LOCALES),
    question: text(ASSISTANT_QUESTION_MAX),
    history: z
      .array(z.object({ role: z.enum(["user", "assistant"]), text: text(ASSISTANT_TURN_MAX) }).strict())
      .max(ASSISTANT_HISTORY_MAX)
      .default([]),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type AssistantRequest = z.input<typeof assistantRequestSchema>;
export type AssistantTurn = z.infer<typeof assistantRequestSchema>["history"][number];

export interface HelpHit {
  slug: string;
  title: string;
  summary: string;
}

/**
 * `ai`: Claude's answer and the articles it relied on. `search`: the AI is not available (budget
 * reached, provider down or not configured): only the help articles matching the question.
 */
export type AssistantResponse = { mode: "ai"; answer: string; articles: HelpHit[] } | { mode: "search"; articles: HelpHit[] };
