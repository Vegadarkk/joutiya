import "server-only";

// Public surface of the moderation agent (design D19, D20) for the other modules. The worker runs
// tasks through src/lib/ai/run.ts (src/worker/jobs/agent.ts); nothing here calls a provider.

export { enqueueAiTask, AGENT_QUEUE, AGENT_CONCURRENCY, agentJobSchema } from "./queue";
export type { AgentJobData } from "./queue";
export { latestAiDecision, markAiDecision, markAiDecisionTx, getAiDecision, listAiDecisions, aiTargetKey, parseAiTargetKey } from "./repository";
export type { AiDecisionRecord, ReviewOutcome } from "./repository";
export { aiConfig } from "./config";
export { claudeBlocked } from "./budget";
export type { AiTask, AiTarget, AiTargetType, AiOutput, AiProviderId } from "./types";
