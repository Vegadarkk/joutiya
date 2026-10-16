import "server-only";
import type { AiConfig } from "@/config/ai";
import { serverEnv } from "@/lib/env";
import { z } from "@/lib/zod";
import { aiConfig } from "../config";
import { escalation, type Policy } from "../output";
import { ProviderError, type AiOutput, type AiProvider, type AiSeverity, type AiTaskInput, type ProviderResult } from "../types";

// Free fallback 1 (design D19): OpenAI's moderation endpoint (omni-moderation-latest, text and
// images, no prepaid credit). A generic harm classifier, not a marketplace-policy judge: it can
// only escalate to a human ("hold" when a category score reaches `fallback.openaiHoldAt`, else
// "escalate" with severity none), never approve or reject. Plain fetch, no SDK.

export const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";
const TIMEOUT_MS = 20_000;

const responseSchema = z.object({
  model: z.string().max(80).optional(),
  results: z
    .array(z.object({ flagged: z.boolean(), category_scores: z.record(z.string(), z.number()) }))
    .min(1)
    .max(10),
});

/** OpenAI category -> report reason and severity (text-only categories score 0 on images). */
const CATEGORY_POLICY: Record<string, { policy: Policy; severity: AiSeverity }> = {
  "sexual/minors": { policy: "minors", severity: "P0" },
  "hate/threatening": { policy: "threat", severity: "P0" },
  "harassment/threatening": { policy: "threat", severity: "P0" },
  "illicit/violent": { policy: "illegal_item", severity: "P1" },
  illicit: { policy: "illegal_item", severity: "P1" },
  sexual: { policy: "sexual_content", severity: "P1" },
  hate: { policy: "hate", severity: "P1" },
  "violence/graphic": { policy: "other", severity: "P1" },
  violence: { policy: "other", severity: "P2" },
  harassment: { policy: "harassment", severity: "P2" },
  "self-harm": { policy: "other", severity: "P1" },
  "self-harm/intent": { policy: "other", severity: "P1" },
  "self-harm/instructions": { policy: "other", severity: "P1" },
};
const SEVERITY_RANK: Record<AiSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3, none: 4 };

/** Proposal from the category scores: the most severe category at or above the threshold, else no signal. */
export function moderationOutput(scores: Record<string, number>, holdAt: number, targetIsListing: boolean): AiOutput {
  const hits = Object.entries(scores)
    .filter(([category, score]) => CATEGORY_POLICY[category] && Number.isFinite(score) && score >= holdAt)
    .map(([category, score]) => ({ category, score, ...(CATEGORY_POLICY[category] as { policy: Policy; severity: AiSeverity }) }))
    // "harassment" does not apply to a listing: it then counts as "other".
    .map((hit) => (targetIsListing && hit.policy === "harassment" ? { ...hit, policy: "other" as Policy } : hit))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.score - a.score);
  const top = hits[0];
  if (!top) return escalation("Secours (modération OpenAI) : aucun signal ; un modérateur décide.");
  return {
    action: "hold",
    policy: top.policy,
    severity: top.severity,
    confidence: Math.round(Math.min(1, Math.max(0, top.score)) * 1000) / 1000,
    rationale: `Secours (modération OpenAI) : catégorie « ${top.category} » à ${Math.round(top.score * 100)} %. À vérifier par un modérateur.`,
  };
}

export interface OpenAiModerationOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  config?: () => Promise<AiConfig>;
}

export function createOpenAiModerationProvider(options: OpenAiModerationOptions = {}): AiProvider {
  const apiKey = () => options.apiKey ?? serverEnv().OPENAI_API_KEY;
  const doFetch = options.fetch ?? fetch;
  const loadConfig = options.config ?? aiConfig;
  return {
    id: "openai",
    async available(task) {
      // An appeal is the appellant's own complaint: a harm classifier says nothing useful about it.
      return task !== "appeal_review" && Boolean(apiKey());
    },
    async run(input: AiTaskInput): Promise<ProviderResult> {
      const key = apiKey();
      if (!key) throw new ProviderError("openai", "unavailable", "no key");
      const config = await loadConfig();
      const model = config.fallback.openaiModel;
      const body = {
        model,
        input: [
          { type: "text", text: input.text },
          ...input.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
        ],
      };
      let response: Response;
      try {
        response = await doFetch(OPENAI_MODERATION_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new ProviderError("openai", "unavailable", (error as Error).name);
      }
      if (response.status === 401 || response.status === 403) throw new ProviderError("openai", "auth", `status ${response.status}`);
      if (response.status === 429) throw new ProviderError("openai", "quota", "status 429");
      if (!response.ok) throw new ProviderError("openai", "unavailable", `status ${response.status}`);
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ProviderError("openai", "invalid_output");
      // One result per input array: merge the scores (max per category).
      const scores: Record<string, number> = {};
      for (const result of parsed.data.results) {
        for (const [category, score] of Object.entries(result.category_scores)) scores[category] = Math.max(scores[category] ?? 0, score);
      }
      return { output: moderationOutput(scores, config.fallback.openaiHoldAt, input.target.type === "listing"), model: parsed.data.model ?? model, costMicroUsd: 0 };
    },
  };
}
