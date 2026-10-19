import "server-only";
import type { AiConfig } from "@/config/ai";
import { serverEnv } from "@/lib/env";
import { consume, isDegraded } from "@/lib/quota";
import { z } from "@/lib/zod";
import { aiConfig } from "../config";
import { escalation, type Policy } from "../output";
import { ProviderError, type AiOutput, type AiSeverity, type AiTaskInput, type ModerationClassifier, type ProviderResult } from "../types";

// Free fallback 2 (design D19): Cloudflare Workers AI, Llama Guard 3 8B, through the REST API
// (text only). Generic safety categories S1-S14: "unsafe" proposes a hold for a human, "safe" is no
// signal; never an approval. Neurons are counted app-side in `workersAi.neurons` (10 000 a day,
// shared by the Cloudflare account) from the token usage: 44 003 neurons per million input tokens,
// 2 730 per million output tokens (research/ext-ai-providers.md §2).

const TIMEOUT_MS = 20_000;
const NEURONS_PER_INPUT_TOKEN = 0.044003;
const NEURONS_PER_OUTPUT_TOKEN = 0.00273;
/** Neurons counted when the response carries no usage (~1 000 input tokens). */
const DEFAULT_NEURONS = 45;

export function workersAiUrl(accountId: string, model: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model.split("/").map(encodeURIComponent).join("/")}`;
}

const envelopeSchema = z.object({
  success: z.boolean(),
  result: z
    .object({
      response: z.union([z.string(), z.object({ safe: z.boolean(), categories: z.array(z.string()).max(20).optional() })]).optional(),
      usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
    })
    .nullable()
    .optional(),
});

/** Llama Guard 3 hazard categories -> report reason and severity. */
const CATEGORY_POLICY: Record<string, { policy: Policy; severity: AiSeverity; label: string }> = {
  S1: { policy: "threat", severity: "P0", label: "crimes violents" },
  S2: { policy: "illegal_item", severity: "P1", label: "crimes non violents" },
  S3: { policy: "sexual_content", severity: "P1", label: "crimes sexuels" },
  S4: { policy: "minors", severity: "P0", label: "exploitation d'enfants" },
  S5: { policy: "other", severity: "P2", label: "diffamation" },
  S6: { policy: "other", severity: "P2", label: "conseils spécialisés" },
  S7: { policy: "personal_data", severity: "P1", label: "vie privée" },
  S8: { policy: "counterfeit", severity: "P2", label: "propriété intellectuelle" },
  S9: { policy: "illegal_item", severity: "P1", label: "armes" },
  S10: { policy: "hate", severity: "P1", label: "haine" },
  S11: { policy: "other", severity: "P1", label: "automutilation" },
  S12: { policy: "sexual_content", severity: "P1", label: "contenu sexuel" },
  S13: { policy: "other", severity: "P3", label: "élections" },
  S14: { policy: "other", severity: "P3", label: "abus d'interpréteur" },
};
const SEVERITY_RANK: Record<AiSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3, none: 4 };

/** The verdict in either documented shape: `{safe, categories}` or the model's "safe" / "unsafe\nS1,S2" text. */
export function parseGuardVerdict(response: unknown): { safe: boolean; categories: string[] } | null {
  if (typeof response === "object" && response !== null && "safe" in response) {
    const verdict = response as { safe: boolean; categories?: string[] };
    return { safe: verdict.safe, categories: verdict.categories ?? [] };
  }
  if (typeof response !== "string") return null;
  const lines = response.trim().split(/\s*\n\s*/);
  const first = (lines[0] ?? "").toLowerCase();
  if (first === "safe") return { safe: true, categories: [] };
  if (first !== "unsafe") return null;
  return { safe: false, categories: (lines[1] ?? "").split(/[,\s]+/).filter((code) => /^S\d{1,2}$/.test(code)) };
}

export function guardOutput(verdict: { safe: boolean; categories: string[] }): AiOutput {
  if (verdict.safe) return escalation("Secours (Llama Guard) : aucun signal ; un modérateur décide.");
  const hits = verdict.categories
    .map((code) => CATEGORY_POLICY[code])
    .filter((hit): hit is { policy: Policy; severity: AiSeverity; label: string } => Boolean(hit))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const top = hits[0] ?? { policy: "other" as Policy, severity: "P2" as AiSeverity, label: "catégorie inconnue" };
  return {
    action: "hold",
    policy: top.policy,
    severity: top.severity,
    // Llama Guard gives no score: a fixed, modest confidence (a human always decides).
    confidence: 0.6,
    rationale: `Secours (Llama Guard) : contenu jugé à risque (${hits.map((hit) => hit.label).join(", ") || top.label}). À vérifier par un modérateur.`,
  };
}

export interface WorkersAiOptions {
  token?: string;
  accountId?: string;
  fetch?: typeof fetch;
  config?: () => Promise<AiConfig>;
}

export function createWorkersAiProvider(options: WorkersAiOptions = {}): ModerationClassifier {
  const token = () => options.token ?? serverEnv().CF_WORKERS_AI_TOKEN;
  const accountId = () => options.accountId ?? serverEnv().CF_ACCOUNT_ID;
  const doFetch = options.fetch ?? fetch;
  const loadConfig = options.config ?? aiConfig;
  return {
    id: "workers-ai",
    async available(task) {
      if (task === "appeal_review" || !token() || !accountId()) return false;
      return !(await isDegraded("workersAi.neurons"));
    },
    async run(input: AiTaskInput): Promise<ProviderResult> {
      const key = token();
      const account = accountId();
      if (!key || !account) throw new ProviderError("workers-ai", "unavailable", "not configured");
      const config = await loadConfig();
      const model = config.fallback.workersAiModel;
      let response: Response;
      try {
        response = await doFetch(workersAiUrl(account, model), {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: input.text }], max_tokens: 32 }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new ProviderError("workers-ai", "unavailable", (error as Error).name);
      }
      if (response.status === 401 || response.status === 403) throw new ProviderError("workers-ai", "auth", `status ${response.status}`);
      if (response.status === 429) throw new ProviderError("workers-ai", "quota", "status 429");
      const parsed = envelopeSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success || !parsed.data.success) throw new ProviderError("workers-ai", "unavailable", `status ${response.status}`);
      const usage = parsed.data.result?.usage;
      const neurons = usage
        ? Math.ceil((usage.prompt_tokens ?? 0) * NEURONS_PER_INPUT_TOKEN + (usage.completion_tokens ?? 0) * NEURONS_PER_OUTPUT_TOKEN)
        : DEFAULT_NEURONS;
      await consume("workersAi.neurons", Math.max(1, neurons));
      const verdict = parseGuardVerdict(parsed.data.result?.response);
      if (!verdict) throw new ProviderError("workers-ai", "invalid_output");
      return { output: guardOutput(verdict), model, costMicroUsd: 0 };
    },
  };
}
