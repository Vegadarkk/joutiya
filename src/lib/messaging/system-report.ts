import "server-only";

// Repeat rule of the message risk (design D5): a sender with >= 3 flagged messages in 24 h across
// >= 2 conversations gets ONE system report per 24 h: target user, reason `scam` (P1), source
// `system`, never a strong signal. The report itself belongs to the reports lot (L2): imported on
// first use, because "@/lib/reports" imports hideMessage/unhideMessage from "@/lib/messaging"
// statically; this direction stays lazy so the module graph has no cycle.

export interface RepeatRiskReport {
  /** The sender. */
  uid: string;
  publicId: string;
  /** French, for the moderator: counts and flags only, never the message texts. */
  explanation: string;
}

export type RepeatRiskReporter = (input: RepeatRiskReport) => Promise<void>;

const defaultReporter: RepeatRiskReporter = async (input) => {
  const { createSystemReport } = await import("@/lib/reports");
  await createSystemReport({
    target: { type: "user", id: input.uid, ownerUid: input.uid, publicId: input.publicId },
    reasonId: "scam",
    explanation: input.explanation,
    source: "system",
  });
};

let reporter: RepeatRiskReporter = defaultReporter;

export async function fileRepeatRiskReport(input: RepeatRiskReport): Promise<void> {
  await reporter(input);
}

/** Tests: another reporter; undefined restores createSystemReport. */
export function setRepeatRiskReporter(next: RepeatRiskReporter | undefined): void {
  reporter = next ?? defaultReporter;
}
