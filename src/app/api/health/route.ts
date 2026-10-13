import { healthReport } from "@/lib/health";

// Polled by the uptime Worker (§2) outside the VM. 503 when a dependency fails, so the probe
// alerts; no detail beyond check states.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await healthReport();
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
