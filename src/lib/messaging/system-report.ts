import "server-only";
import { logger } from "@/lib/logging/logger";

// Repeat rule of the message risk (design D5): a sender with >= 3 flagged messages in 24 h across
// >= 2 conversations gets ONE system report per 24 h: target user, reason `scam` (P1), source
// `system`, never a strong signal. The report itself belongs to the reports lot (L2).
// TODO(orchestrator, integration L2): replace the body of `fileRepeatRiskReport` by
//   import { createSystemReport } from "@/lib/reports";
//   await createSystemReport({ target: { type: "user", id: input.uid, ownerUid: input.uid, publicId: input.publicId },
//     reasonId: "scam", explanation: input.explanation, source: "system" });
// (adapt the target shape to L2's signature). Until then the rule is evaluated but only logged.

export interface RepeatRiskReport {
  /** The sender. */
  uid: string;
  publicId: string;
  /** French, for the moderator: counts and flags only, never the message texts. */
  explanation: string;
}

export type RepeatRiskReporter = (input: RepeatRiskReport) => Promise<void>;

let reporter: RepeatRiskReporter = async () => {
  logger.warn("messaging: repeat-risk system report not wired yet (reports lot)");
};

export async function fileRepeatRiskReport(input: RepeatRiskReport): Promise<void> {
  await reporter(input);
}

/** Wiring point (integration, tests). */
export function setRepeatRiskReporter(next: RepeatRiskReporter): void {
  reporter = next;
}
