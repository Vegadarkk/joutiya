import "server-only";

// Reports (notice and action, art. 16 / 23 DSA; design phase-5 D10-D12, D15). Server only.
// Decisions (L3) close reports with closeReportsTx, restore with unhideTarget and record the
// reporters' accuracy with recordReporterOutcomes; messaging (L1) raises createSystemReport.

export { createReport, createSystemReport, assertReportInput } from "./service";
export type { CreateReportOptions, CreateReportResult, ReportRequester, SystemReportInput, SystemReportResult } from "./service";
export { closeReportsTx, getReport, listTargetReports, openReportsForTarget, reportHold, CLOSED_STATUSES, OPEN_STATUSES } from "./repository";
export type { CloseReportsInput, ReportRecord, ReportStatus } from "./repository";
export { hideTarget, unhideTarget, adsEligibleOf } from "./visibility";
export { isTrustedReporter, recordReporterOutcomes } from "./reporter";
export type { ReporterOutcomesResult } from "./reporter";
export type { ReporterOutcome, StrongSignal } from "./rules";
export { listQueue, reportTargetView } from "./admin";
export type { ListQueueInput, ReportDetail, ReportQueueItem, ReportQueueResponse, ReportTargetView } from "./admin";
export { parseTargetKey, targetKey } from "./target-key";
export type { TargetRef } from "./target-key";
export type { StoredTarget, SystemTargetInput } from "./targets";
