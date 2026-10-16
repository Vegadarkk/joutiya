import "server-only";
import { logger } from "@/lib/logging/logger";

// After a report is created, the agent proposes a triage (design D10, D19: a proposal only, never
// applied). The AI lot (L4) owns the queue.
// TODO(integration L4): wire `enqueueAiTask("report_triage", { type: "report", id })` here, e.g.
//   setTriageRequester((id) => enqueueAiTask("report_triage", { type: "report", id }).then(() => undefined));
// or replace the default body by that call once src/lib/ai exports it.

export type TriageRequester = (reportId: string) => Promise<void>;

let requester: TriageRequester = async () => undefined;

/** Never throws: a report never fails because the agent queue is down. */
export async function requestTriage(reportId: string): Promise<void> {
  try {
    await requester(reportId);
  } catch (error) {
    logger.warn({ reportId, err: (error as Error).message }, "reports: triage request failed");
  }
}

/** Wiring point (integration, tests). */
export function setTriageRequester(next: TriageRequester): void {
  requester = next;
}
