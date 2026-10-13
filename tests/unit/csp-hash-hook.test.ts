import { createServer, get, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../../src/server/csp-hash-hook.ts";
import { INLINE_HASH_MARKER, scriptHash } from "@/lib/security/inline-hashes";

const FALLBACK = "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'";
const BOOT = "(self.__next_f=self.__next_f||[]).push([0])";
const CHUNK = 'self.__next_f.push([1,"hello"])';
const PAGE = `<!doctype html><html><head><script>${BOOT}</script></head><body><p>x</p><script>${CHUNK}</script><script>alert(1)</script></body></html>`;

type Handler = (res: ServerResponse) => void;
const routes: Record<string, Handler> = {
  // Next.js style: setHeader, then streamed writes.
  "/streamed": (res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", FALLBACK);
    res.setHeader(INLINE_HASH_MARKER, "1");
    const half = Math.floor(PAGE.length / 2);
    res.write(PAGE.slice(0, half));
    res.end(PAGE.slice(half));
  },
  // Headers passed to writeHead.
  "/write-head": (res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": FALLBACK, [INLINE_HASH_MARKER]: "1" });
    res.end(PAGE);
  },
  "/not-flagged": (res) => {
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Security-Policy", FALLBACK);
    res.end(PAGE);
  },
  "/json": (res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Security-Policy", FALLBACK);
    res.setHeader(INLINE_HASH_MARKER, "1");
    res.end("{}");
  },
  "/compressed": (res) => {
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Encoding", "br");
    res.setHeader("Content-Security-Policy", FALLBACK);
    res.setHeader(INLINE_HASH_MARKER, "1");
    res.end(PAGE);
  },
  "/oversized": (res) => {
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Security-Policy", FALLBACK);
    res.setHeader(INLINE_HASH_MARKER, "1");
    const block = "x".repeat(1024 * 1024);
    for (let i = 0; i < 6; i += 1) res.write(block);
    res.end(PAGE);
  },
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => (routes[req.url ?? ""] ?? ((r: ServerResponse) => r.end()))(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Raw request: no automatic decompression (the "compressed" body is not really compressed). */
function raw(path: string): Promise<{ headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    get(base + path, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

describe("CSP hash hook", () => {
  it("flags itself as loaded", () => {
    expect((globalThis as { __joutiyaCspHashHook?: boolean }).__joutiyaCspHashHook).toBe(true);
  });

  for (const path of ["/streamed", "/write-head"]) {
    it(`swaps 'unsafe-inline' for the framework script hashes (${path})`, async () => {
      const response = await fetch(base + path);
      const body = await response.text();
      expect(body).toBe(PAGE);
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain(`script-src 'self' 'sha256-${scriptHash(BOOT)}' 'sha256-${scriptHash(CHUNK)}';`);
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain(scriptHash("alert(1)"));
      expect(response.headers.get(INLINE_HASH_MARKER)).toBeNull();
    });
  }

  it("leaves unflagged HTML untouched", async () => {
    const response = await fetch(`${base}/not-flagged`);
    expect(response.headers.get("content-security-policy")).toBe(FALLBACK);
  });

  for (const path of ["/json", "/compressed"]) {
    it(`keeps the fallback policy and strips the marker (${path})`, async () => {
      const { headers } = await raw(path);
      expect(headers["content-security-policy"]).toBe(FALLBACK);
      expect(headers[INLINE_HASH_MARKER]).toBeUndefined();
    });
  }

  it("passes oversized pages through with the fallback policy", async () => {
    const response = await fetch(`${base}/oversized`);
    const body = await response.text();
    expect(body.length).toBe(6 * 1024 * 1024 + PAGE.length);
    expect(response.headers.get("content-security-policy")).toBe(FALLBACK);
    expect(response.headers.get(INLINE_HASH_MARKER)).toBeNull();
  });
});
