import "server-only";
import type { ReportPriority } from "@/config/report-reasons";
import type { ModerationFlag } from "@/lib/contracts/listings";
import { AI_ACTIONS, AI_PROVIDERS, AI_TASKS, type AiDecisionDoc } from "@/lib/db/schemas";

// The moderation agent (architecture §7 step 6, Z4; design phase-5 D19, D20). Providers receive the
// masked input only (src/lib/ai/mask.ts) and answer a proposal; the agent never sanctions by itself.
//
// Action semantics per task (the prompts say the same):
// - listing_screen: approve = compliant; hold = a human must look before (or while) it is online;
//   reject = clear violation; escalate = cannot tell.
// - report_triage: reject = the report looks founded (remove or restrict the content); approve = the
//   content looks compliant (dismiss); hold = founded but needs a human sanction choice; escalate = unclear.
// - appeal_review: approve = the appeal looks founded (reverse); reject = it looks unfounded (uphold);
//   escalate = unclear. Never applied (D16).

export { AI_ACTIONS, AI_PROVIDERS, AI_TASKS };
export type AiTask = (typeof AI_TASKS)[number];
export type AiProviderId = (typeof AI_PROVIDERS)[number];
export type AiAction = (typeof AI_ACTIONS)[number];
export type AiOutput = AiDecisionDoc["output"];
export type AiSeverity = ReportPriority | "none";

/** What a proposal is about: a listing (screening), a report (triage), a decision (appeal review). */
export type AiTargetType = AiDecisionDoc["target"]["type"];
export interface AiTarget {
  type: AiTargetType;
  id: string;
}

/** The target each task works on. */
export const TASK_TARGET: Record<AiTask, AiTargetType> = {
  listing_screen: "listing",
  report_triage: "report",
  appeal_review: "decision",
};

export interface AiImage {
  mediaType: "image/jpeg";
  /** Base64 of a JPEG <= 1000 px (variant "s" re-encoded). */
  data: string;
}

/** Deterministic facts the rules provider and the D20 application rules use (never sent as is). */
export interface ListingFacts {
  kind: "listing";
  status: string;
  version: number;
  flags: ModerationFlag[];
  score: number;
  hidden: boolean;
  openReports: number;
  /** Hard prohibited groups found in the masked text (src/lib/moderation/prohibited.ts). */
  prohibitedHard: string[];
}
export interface ReportFacts {
  kind: "report";
  reasonId: string;
  priority: ReportPriority;
  targetType: string;
  status: string;
}
export interface AppealFacts {
  kind: "appeal";
  action: string;
  appealStatus: string | null;
}
export type TaskFacts = ListingFacts | ReportFacts | AppealFacts;

/** A task ready for the providers: user content masked, images re-encoded. */
export interface AiTaskInput {
  task: AiTask;
  target: AiTarget;
  /** Masked user content (the providers' only text besides the static system prompt). */
  text: string;
  images: AiImage[];
  facts: TaskFacts;
  /** sha256 of the masked text and image bytes: the same input is not sent twice. */
  inputHash: string;
}

export interface ProviderResult {
  output: AiOutput;
  model: string;
  costMicroUsd: number;
}

export interface AiProvider {
  readonly id: AiProviderId;
  /** True when this provider may run now (key present, quota not degraded, not latched). */
  available(task: AiTask): Promise<boolean>;
  run(input: AiTaskInput): Promise<ProviderResult>;
}

export type ProviderErrorCode = "spend_limit" | "refusal" | "invalid_output" | "max_tokens" | "auth" | "bad_request" | "quota" | "unavailable";

/** The provider failed in a way the router skips to the next one (and the job does not retry). */
export class ProviderError extends Error {
  constructor(
    readonly provider: AiProviderId,
    readonly code: ProviderErrorCode,
    message?: string,
    /** What the failed call still cost (a refusal or a truncated answer is billed). */
    readonly costMicroUsd = 0,
  ) {
    super(message ?? `${provider}: ${code}`);
    this.name = "ProviderError";
  }
}

/** A transient failure of the primary provider (429, 5xx, network): the job retries before falling back. */
export class RetryableAiError extends Error {
  constructor(
    readonly provider: AiProviderId,
    message: string,
  ) {
    super(message);
    this.name = "RetryableAiError";
  }
}

export const isProviderError = (error: unknown): error is ProviderError => error instanceof ProviderError;
