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
    // Phase 5 (design phase-5/DESIGN.md D11, D19, D20).
    agent: z
      .object({
        /** Confidence at or above which an `approve` proposal is applied alone (AF §7 step 6: 0.9). */
        autoApproveAt: score,
        /** Confidence at or above which an obvious-spam `reject` is applied alone (0.97). */
        autoRejectSpamAt: score,
        /** Flags that do not count as a risk signal for the auto-approval (empty: any flag blocks it). */
        autoApproveSoftFlags: z.array(z.string().min(1).max(40)).max(20),
        /** Screen published (auto_ok) listings after publication; a hold becomes a system report. */
        screenPublished: z.boolean(),
      })
      .strict(),
    reports: z
      .object({
        /** Nudity score of a listing photo at or above which a P0 report is a strong signal ("auto"). */
        autoHideNsfwAt: score,
      })
      .strict(),
    /** Trusted flaggers (art. 22 DSA) and authorities' accounts: their P0 reports are strong signals. */
    trustedFlaggers: z.array(z.string().min(1).max(128)).max(50),
    models: z
      .object({ screen: z.string().min(1).max(80), triage: z.string().min(1).max(80), appeal: z.string().min(1).max(80), assistant: z.string().min(1).max(80) })
      .strict(),
    /** USD per million tokens, by model id (cost accounting into the `claude.budget` quota). */
    prices: z.record(
      z.string().min(1).max(80),
      z.object({ input: z.number().min(0), output: z.number().min(0), cacheRead: z.number().min(0), cacheWrite: z.number().min(0) }).strict(),
    ),
    fallback: z
      .object({
        openaiModel: z.string().min(1).max(80),
        workersAiModel: z.string().min(1).max(120),
        /** OpenAI moderation category score at or above which the fallback proposes a hold. */
        openaiHoldAt: score,
      })
      .strict(),
  })
  .strict();
export type AiConfig = z.infer<typeof aiConfigSchema>;

export const DEFAULT_AI: AiConfig = {
  nsfw: { rejectAt: 0.85, reviewAt: 0.6 },
  face: { minConfidence: 0.6 },
  risk: { reviewAt: 60 },
  agent: { autoApproveAt: 0.9, autoRejectSpamAt: 0.97, autoApproveSoftFlags: [], screenPublished: true },
  reports: { autoHideNsfwAt: 0.95 },
  trustedFlaggers: [],
  models: { screen: "claude-haiku-5-5", triage: "claude-haiku-5-5", appeal: "claude-sonnet-5-5", assistant: "claude-haiku-5-5" },
  // Verified 2026-10-16 (platform.claude.com pricing; research/ext-ai-providers.md): 1-hour cache writes.
  prices: {
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  },
  fallback: { openaiModel: "omni-moderation-latest", workersAiModel: "@cf/meta/llama-guard-3-8b", openaiHoldAt: 0.5 },
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
