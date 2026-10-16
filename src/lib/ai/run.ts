import "server-only";
import { logger } from "@/lib/logging/logger";
import { applyAutoDecision, noteOnListing, noteOnReport, planApplication, raiseSystemReport, type Application } from "./apply";
import { aiConfig } from "./config";
import { appealReviewInput, listingScreenInput, reportTriageInput, type InputDeps } from "./inputs";
import { PROMPT_VERSIONS } from "./prompts";
import type { AgentJobData } from "./queue";
import { createAiDecision, listAiDecisions } from "./repository";
import { routeTask, type ProviderRegistry } from "./router";
import type { AiProviderId, AiTaskInput } from "./types";

// One agent task, end to end (worker only, design D19, D20): build the masked input, skip an input
// already answered, route it through the provider chain, store the proposal (aiDecisions), then
// apply what D20 allows (held listing approved or rejected as spam, system report on a published
// listing) or just record it. Logs carry ids, providers and actions, never content.

export interface AgentRunOptions extends InputDeps {
  /** Last attempt of the job: a transient Claude failure falls back instead of throwing. */
  final?: boolean;
  providers?: ProviderRegistry;
  now?: Date;
}

export interface AgentRunResult {
  status: "done" | "skipped" | "duplicate";
  aiDecisionId?: string;
  provider?: AiProviderId;
  application?: Application["kind"];
  /** Auto-application not done because the listing moved meanwhile. */
  stale?: boolean;
}

/** Recent proposals compared for an identical input. */
const DEDUPE_WINDOW = 5;

async function buildInput(job: AgentJobData, deps: InputDeps): Promise<AiTaskInput | null> {
  switch (job.task) {
    case "listing_screen":
      return (await listingScreenInput(job.target.id, deps))?.input ?? null;
    case "report_triage":
      return (await reportTriageInput(job.target.id, deps))?.input ?? null;
    case "appeal_review":
      return (await appealReviewInput(job.target.id))?.input ?? null;
  }
}

export async function runAgentTask(job: AgentJobData, options: AgentRunOptions = {}): Promise<AgentRunResult> {
  const now = options.now ?? new Date();
  const input = await buildInput(job, options);
  if (!input) {
    logger.info({ task: job.task, target: job.target.type }, "ai: nothing to do (target gone or closed)");
    return { status: "skipped" };
  }
  const previous = (await listAiDecisions(input.target, DEDUPE_WINDOW)).find((decision) => decision.task === input.task && decision.inputHash === input.inputHash && !decision.error);
  if (previous) return { status: "duplicate", aiDecisionId: previous.id };

  const route = await routeTask(input, options.providers, { final: options.final ?? false });
  const config = await aiConfig();
  const aiDecisionId = await createAiDecision({
    task: input.task,
    target: input.target,
    provider: route.provider,
    model: route.model,
    promptVersion: route.provider === "anthropic" ? PROMPT_VERSIONS[input.task] : "none",
    output: route.output,
    applied: "pending",
    costMicroUsd: route.costMicroUsd,
    inputHash: input.inputHash,
    ...(route.error ? { error: route.error } : {}),
    now,
  });

  const plan = planApplication(input.task, route.provider, route.output, input.facts, config);
  const result: AgentRunResult = { status: "done", aiDecisionId, provider: route.provider, application: plan.kind };
  const note = { decisionId: aiDecisionId, action: route.output.action, confidence: route.output.confidence };
  switch (plan.kind) {
    case "auto_approve":
    case "auto_reject_spam": {
      if (input.facts.kind !== "listing") break;
      const outcome = await applyAutoDecision(plan.kind === "auto_approve" ? "approve" : "reject", {
        listingId: input.target.id,
        version: input.facts.version,
        aiDecisionId,
        confidence: route.output.confidence,
        now,
      });
      if (!outcome.applied) {
        result.stale = true;
        await noteOnListing(input.target.id, { ...note, applied: false });
      }
      break;
    }
    case "system_report":
      await raiseSystemReport(input.target.id, plan.reasonId, route.output, aiDecisionId);
      await noteOnListing(input.target.id, { ...note, applied: false });
      break;
    case "record":
      if (input.task === "listing_screen") await noteOnListing(input.target.id, { ...note, applied: false });
      if (input.task === "report_triage") await noteOnReport(input.target.id, aiDecisionId);
      break;
  }
  logger.info({ task: input.task, provider: route.provider, action: route.output.action, application: plan.kind, aiDecisionId, costMicroUsd: route.costMicroUsd }, "ai: task done");
  return result;
}
