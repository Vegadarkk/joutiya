import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiConfig } from "@/config/ai";
import { serverEnv } from "@/lib/env";
import { claudeBlocked, latchSpendLimit, recordClaudeCost } from "../budget";
import { aiConfig } from "../config";
import { clampOutput, modelOutputSchema, type ModelOutput } from "../output";
import { systemPrompt } from "../prompts";
import { ProviderError, RetryableAiError, type AiProvider, type AiTask, type AiTaskInput, type ProviderResult } from "../types";

// Claude through the official SDK (design D19): `messages.parse` with a Zod output format, the
// static system prompt cached one hour, Haiku 5.5 with thinking disabled and effort low for the
// screening and the triage, Sonnet 5.5 at effort medium for appeals (its thinking cannot be
// disabled). No SDK retries (`maxRetries: 0`): BullMQ retries the job on transient failures. Each
// response's `usage` is priced into `claude.budget`, refused and truncated answers included.

type Effort = "low" | "medium";

export const TASK_SETTINGS: Record<AiTask, { model: keyof AiConfig["models"]; effort: Effort; maxTokens: number }> = {
  listing_screen: { model: "screen", effort: "low", maxTokens: 1024 },
  report_triage: { model: "triage", effort: "low", maxTokens: 1024 },
  appeal_review: { model: "appeal", effort: "medium", maxTokens: 8000 },
};

/** Haiku 5.5 accepts `thinking: disabled` at effort high or below; Sonnet 5.5 refuses it (400). */
const canDisableThinking = (model: string) => model.startsWith("claude-haiku-");

/** First words of the 400 the API answers once a self-set spend limit is reached (org or workspace). */
const SPEND_LIMIT_MESSAGE = /you have reached your specified (?:workspace )?api usage limits/i;

/** The part of the SDK client this provider uses (a stub in tests). */
export interface ClaudeClient {
  messages: Pick<Anthropic["messages"], "parse">;
}

function errorBody(error: InstanceType<typeof Anthropic.APIError>): { message: string; errorCode: string | undefined } {
  const body = (error.error ?? {}) as { error?: { message?: unknown; details?: { error_code?: unknown } } };
  const message = typeof body.error?.message === "string" ? body.error.message : (error.message ?? "");
  const errorCode = typeof body.error?.details?.error_code === "string" ? body.error.details.error_code : undefined;
  return { message, errorCode };
}

/** Spend limit (latched), retryable (429, 5xx, network) or a provider error the router skips. */
export function classifyAnthropicError(error: unknown): ProviderError | RetryableAiError {
  if (error instanceof Anthropic.APIConnectionError) return new RetryableAiError("anthropic", "connection error");
  if (error instanceof Anthropic.APIError) {
    const { message, errorCode } = errorBody(error);
    const status = error.status ?? 0;
    if ((status === 400 && SPEND_LIMIT_MESSAGE.test(message)) || (status === 429 && errorCode === "enforced_spend_limit_reached")) {
      return new ProviderError("anthropic", "spend_limit", "spend limit reached");
    }
    if (status === 429 || status === 408 || status === 409 || status >= 500) return new RetryableAiError("anthropic", `status ${status}`);
    if (status === 401 || status === 403) return new ProviderError("anthropic", "auth", `status ${status}`);
    return new ProviderError("anthropic", "bad_request", `status ${status} ${error.type ?? ""}`.trim());
  }
  return new ProviderError("anthropic", "unavailable", (error as Error)?.message?.slice(0, 120) ?? "unknown error");
}

export interface AnthropicProviderOptions {
  /** Defaults to the SDK client built from ANTHROPIC_API_KEY. */
  client?: ClaudeClient;
  apiKey?: string;
  config?: () => Promise<AiConfig>;
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): AiProvider {
  const loadConfig = options.config ?? aiConfig;
  let client = options.client;
  const apiKey = () => options.apiKey ?? serverEnv().ANTHROPIC_API_KEY;
  const getClient = (): ClaudeClient => {
    client ??= new Anthropic({ apiKey: apiKey(), maxRetries: 0, timeout: 120_000 });
    return client;
  };

  return {
    id: "anthropic",
    async available() {
      if (!options.client && !apiKey()) return false;
      return (await claudeBlocked()) === null;
    },
    async run(input: AiTaskInput): Promise<ProviderResult> {
      const config = await loadConfig();
      const settings = TASK_SETTINGS[input.task];
      const model = config.models[settings.model];
      const format = zodOutputFormat(modelOutputSchema);
      // A refused or truncated answer does not match the schema: parse to null instead of throwing,
      // so the usage of the billed call is still counted.
      const lenient = {
        ...format,
        parse: (content: string): ModelOutput | null => {
          try {
            return format.parse(content);
          } catch {
            return null;
          }
        },
      };
      const content: Anthropic.ContentBlockParam[] = [];
      input.images.forEach((image, index) => {
        content.push({ type: "text", text: `Image ${index + 1}:` });
        content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
      });
      content.push({ type: "text", text: input.text });

      let response;
      try {
        response = await getClient().messages.parse({
          model,
          max_tokens: settings.maxTokens,
          system: [{ type: "text", text: systemPrompt(input.task), cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: [{ role: "user", content }],
          output_config: { effort: settings.effort, format: lenient },
          ...(canDisableThinking(model) ? { thinking: { type: "disabled" as const } } : {}),
        });
      } catch (error) {
        const classified = classifyAnthropicError(error);
        if (classified instanceof ProviderError && classified.code === "spend_limit") await latchSpendLimit();
        throw classified;
      }

      const costMicroUsd = await recordClaudeCost(config, model, response.usage);
      if (response.stop_reason === "refusal") throw new ProviderError("anthropic", "refusal", `refusal ${response.stop_details?.category ?? ""}`.trim(), costMicroUsd);
      if (response.stop_reason === "max_tokens") throw new ProviderError("anthropic", "max_tokens", undefined, costMicroUsd);
      const parsed = response.parsed_output;
      if (!parsed) throw new ProviderError("anthropic", "invalid_output", undefined, costMicroUsd);
      return { output: clampOutput(input.task, parsed), model, costMicroUsd };
    },
  };
}
