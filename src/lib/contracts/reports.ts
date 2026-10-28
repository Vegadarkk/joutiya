import { z } from "@/lib/zod";
import { turnstileTokenSchema } from "@/lib/contracts/auth";
import { REPORT_PRIORITIES, REPORT_REASON_IDS, REPORT_TARGET_TYPES, type ReportPriority } from "@/config/report-reasons";
import { REPORT_EXPLANATION_MAX, REPORT_EXPLANATION_MIN } from "./endpoints";

// Notice-and-action form (art. 16 DSA, design D10): target, reason, explanation, good-faith
// statement; name and e-mail of an anonymous reporter (optional for P0 reasons, art. 16(2)(c)).

export { REPORT_EXPLANATION_MAX, REPORT_EXPLANATION_MIN, REPORT_PRIORITIES, REPORT_TARGET_TYPES };

/**
 * Target as the browser knows it: listing id, profile publicId, `{cid}/{messageId}` for a message,
 * shop slug for a pro (phase 7). The server resolves it to the owner's uid.
 */
export const reportTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("listing"), id: z.string().regex(/^[A-Za-z0-9]{8}$/) }).strict(),
  z.object({ type: z.literal("user"), id: z.string().regex(/^[a-hj-km-np-z2-9]{10}$/) }).strict(),
  z.object({ type: z.literal("message"), id: z.string().regex(/^[A-Za-z0-9_-]{22}\/[A-Za-z0-9]{20}$/) }).strict(),
  z.object({ type: z.literal("pro"), id: z.string().regex(/^[a-z0-9-]{3,64}$/) }).strict(),
]);
export type ReportTargetInput = z.infer<typeof reportTargetSchema>;

export const createReportSchema = z
  .object({
    target: reportTargetSchema,
    reasonId: z.enum(REPORT_REASON_IDS),
    explanation: z.string().trim().min(REPORT_EXPLANATION_MIN).max(REPORT_EXPLANATION_MAX),
    /** Art. 16(2)(d): statement that the notice is accurate and complete, in good faith. */
    goodFaith: z.literal(true),
    name: z.string().trim().min(2).max(80).optional(),
    email: z.string().trim().email().max(254).optional(),
    turnstileToken: turnstileTokenSchema.optional(),
  })
  .strict();
export type CreateReportRequest = z.infer<typeof createReportSchema>;

export interface CreateReportResponse {
  reportId: string;
  /** The same reporter already has an open report on this target: nothing new was created. */
  duplicate: boolean;
  priority: ReportPriority;
  /** Target delay of the decision, in hours. */
  slaHours: number;
}
