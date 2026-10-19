import type { SessionSummary } from "@/lib/contracts/auth";

/** Accounts that message: individuals and Pros. Staff accounts never do (design phase-5 D8). */
export function canMessage(session: SessionSummary | null | undefined): session is SessionSummary {
  return Boolean(session) && (session?.role === "individual" || session?.role === "pro");
}
