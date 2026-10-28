import { apiPost } from "@/lib/auth/client";
import { REPORT_API } from "@/lib/contracts/endpoints";
import type { CreateReportRequest, CreateReportResponse } from "@/lib/contracts/reports";

// Browser side of the notice form (art. 16 DSA, design D10): one same-origin POST with the CSRF
// header when a session exists (lib/auth/client). Type-only contract imports: the listing page's
// report chunk stays free of zod.

/** POST /api/reports: 201 a new report, 200 the reporter's open report on the same target (`duplicate`). */
export function submitReport(input: CreateReportRequest): Promise<CreateReportResponse> {
  return apiPost<CreateReportResponse>(REPORT_API.reports, input);
}
