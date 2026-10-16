import { z } from "@/lib/zod";

// Thresholds of the local image models and of the risk score (architecture §7, design D7 and D8).
// Live values will come from Firestore `config/ai` (admin-edited, journaled, 5-minute cache); this
// file holds the schema and the defaults. Scores are probabilities in [0, 1]; the risk score is an
// integer in [0, 100].

const score = z.number().min(0).max(1);

export const aiConfigSchema = z
  .object({
    nsfw: z
      .object({
        /** Score at or above which the photo is rejected at upload (never the listing). */
        rejectAt: score,
        /** Score at or above which the listing is flagged `nsfw_review`. */
        reviewAt: score,
      })
      .strict()
      .refine((nsfw) => nsfw.reviewAt <= nsfw.rejectAt, { message: "reviewAt must not exceed rejectAt", path: ["reviewAt"] }),
    face: z
      .object({
        /** Detection confidence at or above which the listing is flagged `face`. */
        minConfidence: score,
      })
      .strict(),
    risk: z
      .object({
        /** Risk score at or above which the listing goes to `needs_review` (D8). */
        reviewAt: z.number().int().min(0).max(100),
      })
      .strict(),
  })
  .strict();
export type AiConfig = z.infer<typeof aiConfigSchema>;

export const DEFAULT_AI: AiConfig = {
  nsfw: { rejectAt: 0.85, reviewAt: 0.6 },
  face: { minConfidence: 0.6 },
  risk: { reviewAt: 60 },
};

/** Firestore value over the defaults; an invalid document is reported and the defaults apply. */
export function resolveAiConfig(stored: unknown): { config: AiConfig; errors: string[] } {
  if (stored === undefined || stored === null) return { config: DEFAULT_AI, errors: [] };
  const parsed = aiConfigSchema.safeParse({ ...DEFAULT_AI, ...(typeof stored === "object" ? stored : {}) });
  if (parsed.success) return { config: parsed.data, errors: [] };
  return {
    config: DEFAULT_AI,
    errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "config/ai"}: ${issue.message}`),
  };
}
