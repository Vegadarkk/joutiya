import { readCapped } from "@/lib/http/body";
import { logger } from "@/lib/logging/logger";

// CSP violation reports (report-uri and Reporting API). Logged, sampled, never stored.
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024;
const PER_MINUTE = 60;
let window = { start: 0, count: 0 };

function sample(): boolean {
  const now = Date.now();
  if (now - window.start > 60_000) window = { start: now, count: 0 };
  window.count += 1;
  return window.count <= PER_MINUTE;
}

function path(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).pathname;
  } catch {
    return value.slice(0, 200);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES) return new Response(null, { status: 413 });
  // Chunked bodies carry no Content-Length: the read itself is capped.
  const text = await readCapped(request.body, MAX_BYTES);
  if (text === null) return new Response(null, { status: 413 });
  if (sample()) {
    try {
      const payload: unknown = JSON.parse(text);
      const reports = Array.isArray(payload) ? payload.map((entry) => (entry as { body?: unknown }).body) : [(payload as { "csp-report"?: unknown })["csp-report"]];
      for (const report of reports.slice(0, 5)) {
        const r = (report ?? {}) as Record<string, unknown>;
        logger.warn(
          {
            csp: {
              directive: r["effectiveDirective"] ?? r["effective-directive"] ?? r["violated-directive"],
              blocked: path(r["blockedURL"] ?? r["blocked-uri"]),
              page: path(r["documentURL"] ?? r["document-uri"]),
              disposition: r["disposition"],
            },
          },
          "csp violation",
        );
      }
    } catch {
      // Malformed report: ignored.
    }
  }
  return new Response(null, { status: 204 });
}
