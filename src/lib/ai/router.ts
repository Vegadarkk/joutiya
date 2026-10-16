import "server-only";
import { alert } from "@/lib/alert";
import { logger } from "@/lib/logging/logger";
import { escalation } from "./output";
import { createAnthropicProvider } from "./providers/anthropic";
import { createOpenAiModerationProvider } from "./providers/openai-moderation";
import { createRulesProvider, RULES_MODEL } from "./providers/rules";
import { createWorkersAiProvider } from "./providers/workers-ai";
import { ProviderError, RetryableAiError, type AiOutput, type AiProvider, type AiProviderId, type AiTask, type AiTaskInput } from "./types";

// Provider chain per task (design D19): Claude first, then the free fallbacks (OpenAI moderation,
// Workers AI Llama Guard), then the deterministic rules, which always answer. A provider is skipped
// when it is unavailable (no key, `claude.budget` degraded at 4 USD, spend-limit latch, neurons
// exhausted) or when it fails. A transient Claude failure (429, 5xx, network) throws instead, so
// BullMQ retries the job, until its last attempt (`final`), which falls back. Whatever a fallback
// answers, it can only escalate to a human: an approval becomes an escalation, a rejection a hold.

export const TASK_CHAINS: Record<AiTask, readonly AiProviderId[]> = {
  listing_screen: ["anthropic", "openai", "workers-ai", "rules"],
  report_triage: ["anthropic", "openai", "workers-ai", "rules"],
  // Harm classifiers say nothing about a complaint: Claude, else a human.
  appeal_review: ["anthropic", "rules"],
};

export type ProviderRegistry = Partial<Record<AiProviderId, AiProvider>>;

let defaults: ProviderRegistry | undefined;

/** The production providers (keys from the environment), built once. */
export function defaultProviders(): ProviderRegistry {
  defaults ??= {
    anthropic: createAnthropicProvider(),
    openai: createOpenAiModerationProvider(),
    "workers-ai": createWorkersAiProvider(),
    rules: createRulesProvider(),
  };
  return defaults;
}

export interface RouteResult {
  provider: AiProviderId;
  model: string;
  output: AiOutput;
  /** Cost of every call of this run, failed ones included. */
  costMicroUsd: number;
  /** Failures of the providers tried before the one that answered (codes only, no content). */
  error?: string;
}

export interface RouteOptions {
  /** Last attempt of the job: a transient Claude failure falls back instead of throwing. */
  final?: boolean;
}

/** A fallback's answer, bounded to what a fallback may propose (never approve, never reject). */
export function guardFallback(provider: AiProviderId, output: AiOutput): AiOutput {
  if (provider === "anthropic") return output;
  if (output.action === "approve") return { ...output, action: "escalate", confidence: 0 };
  if (output.action === "reject") return { ...output, action: "hold" };
  return output;
}

async function isAvailable(provider: AiProvider, task: AiTask): Promise<boolean> {
  try {
    return await provider.available(task);
  } catch (error) {
    logger.warn({ provider: provider.id, err: (error as Error).message }, "ai: availability check failed");
    return false;
  }
}

/** Runs `input` through the task's chain; never answers an approval from a fallback. */
export async function routeTask(input: AiTaskInput, providers: ProviderRegistry = defaultProviders(), options: RouteOptions = {}): Promise<RouteResult> {
  const errors: string[] = [];
  let cost = 0;
  const done = (provider: AiProviderId, model: string, output: AiOutput): RouteResult => ({
    provider,
    model,
    output: guardFallback(provider, output),
    costMicroUsd: cost,
    ...(errors.length > 0 ? { error: errors.join("; ").slice(0, 200) } : {}),
  });

  for (const id of TASK_CHAINS[input.task]) {
    const provider = providers[id];
    if (!provider || !(await isAvailable(provider, input.task))) continue;
    try {
      const result = await provider.run(input);
      cost += result.costMicroUsd;
      return done(id, result.model, result.output);
    } catch (error) {
      if (error instanceof RetryableAiError && !options.final) throw error;
      const code = error instanceof ProviderError ? error.code : error instanceof RetryableAiError ? "retry_exhausted" : "error";
      if (error instanceof ProviderError) cost += error.costMicroUsd;
      errors.push(`${id}: ${code}`);
      logger.warn({ provider: id, task: input.task, code }, "ai: provider failed, next in chain");
      if (code === "auth" || code === "bad_request") {
        // A configuration or code problem, not an outage: say it once an hour (alert dedupe).
        await alert({ severity: "P2", title: `Agent IA : erreur ${code} chez ${id}`, body: `Tâche ${input.task}. Les tâches passent au fournisseur suivant ; vérifiez la clé ou la requête.` });
      }
    }
  }
  return done("rules", RULES_MODEL, escalation("Aucun fournisseur disponible ; un modérateur décide."));
}

/** Tests only. */
export function resetDefaultProviders(): void {
  defaults = undefined;
}
