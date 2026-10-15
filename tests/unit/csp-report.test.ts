import { describe, expect, it, vi } from "vitest";
import { readCapped } from "@/lib/http/body";

vi.mock("@/lib/logging/logger", () => ({ logger: { warn: vi.fn() } }));

const { POST } = await import("@/app/api/csp-report/route");
const { logger } = await import("@/lib/logging/logger");

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("readCapped", () => {
  it("decodes a body split across chunks, multi-byte characters included", async () => {
    const encoded = bytes("véhicule à Fès");
    expect(await readCapped(stream([encoded.slice(0, 2), encoded.slice(2, 3), encoded.slice(3)]), 1024)).toBe("véhicule à Fès");
    expect(await readCapped(null, 1024)).toBe("");
  });

  it("stops reading once the cap is exceeded", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    expect(await readCapped(endless, 4096)).toBeNull();
    expect(pulled).toBeLessThan(10);
  });
});

describe("POST /api/csp-report", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    POST(new Request("http://localhost/api/csp-report", { method: "POST", body, headers: { "Content-Type": "application/csp-report", ...headers } }));

  it("logs a report and answers 204", async () => {
    const report = JSON.stringify({ "csp-report": { "effective-directive": "script-src", "blocked-uri": "https://evil.example/x.js", "document-uri": "https://joutiya.ma/fr" } });
    expect((await post(report)).status).toBe(204);
    expect(logger.warn).toHaveBeenCalledWith(
      { csp: { directive: "script-src", blocked: "/x.js", page: "/fr", disposition: undefined } },
      "csp violation",
    );
  });

  it("refuses oversized bodies, announced or not", async () => {
    expect((await post("{}", { "Content-Length": "9000" })).status).toBe(413);
    // No Content-Length (chunked): only the capped read can tell.
    expect((await post("x".repeat(9000))).status).toBe(413);
  });
});
