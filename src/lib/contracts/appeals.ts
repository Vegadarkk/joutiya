import { z } from "@/lib/zod";
import { APPEAL_TEXT_MAX, APPEAL_TEXT_MIN } from "./endpoints";

// Internal complaint against a moderation decision (art. 20 DSA, design D16): open 6 months after
// the notification, reviewed by another moderator, answered within 14 days.

export { APPEAL_TEXT_MAX, APPEAL_TEXT_MIN };
export const APPEAL_SLA_DAYS = 14;

const appealTextSchema = z.string().trim().min(APPEAL_TEXT_MIN).max(APPEAL_TEXT_MAX);

/** Signed-in affected user (suspended accounts included). */
export const createAppealSchema = z.object({ decisionId: z.string().regex(/^[A-Za-z0-9]{20}$/), text: appealTextSchema }).strict();
export type CreateAppealRequest = z.infer<typeof createAppealSchema>;

/** Banned account or reporter: the signed link of the decision or outcome e-mail. */
export const linkAppealSchema = z.object({ token: z.string().min(20).max(1024), text: appealTextSchema }).strict();
export type LinkAppealRequest = z.infer<typeof linkAppealSchema>;

export interface AppealResponse {
  status: "open";
  slaDays: number;
}
