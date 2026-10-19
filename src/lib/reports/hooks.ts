import "server-only";
import { logger } from "@/lib/logging/logger";

// After a report is created, the agent proposes a triage (design D10, D19: a proposal only, never
// applied): a `report_triage` task on the agent queue, owned by the AI lot (L4). Imported lazily,
// like src/lib/decisions/hooks.ts: the agent's apply step reaches back to the reports module for
// its system reports, so neither module needs the other at load time. Tests replace the requester
// with setTriageRequester.

export type TriageRequester = (reportId: string) => Promise<void>;

const defaultRequester: TriageRequester = async (reportId) => {
  const { enqueueAiTask } = await import("@/lib/ai");
  await enqueueAiTask("report_triage", { type: "report", id: reportId });
};

let requester: TriageRequester = defaultRequester;

/** Never throws: a report never fails because the agent queue is down. */
export async function requestTriage(reportId: string): Promise<void> {
  try {
    await requester(reportId);
  } catch (error) {
    logger.warn({ reportId, err: (error as Error).message }, "reports: triage request failed");
  }
}

/** Tests: another requester; undefined restores the agent queue. */
export function setTriageRequester(next: TriageRequester | undefined): void {
  requester = next ?? defaultRequester;
}
