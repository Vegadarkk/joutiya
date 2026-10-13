// Preloaded into the production web server (`node --import ./csp-hash-hook.mjs server.js`).
// For HTML responses flagged by src/proxy.ts, it buffers the body, hashes the inline scripts and
// tightens the CSP from the fallback (script-src 'self' 'unsafe-inline') to 'self' + hashes.
// Any doubt (compressed body, oversized page, no CSP header) leaves the fallback policy: the page
// keeps working, with a weaker but still restrictive CSP. Compression is off in next.config.ts;
// Cloudflare compresses at the edge.

import { ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { INLINE_HASH_MARKER, inlineScriptHashes, withScriptHashes } from "../lib/security/inline-hashes.ts";

const MAX_BUFFER = 5 * 1024 * 1024;
const CSP_HEADERS = ["content-security-policy", "content-security-policy-report-only"];
const STATE = Symbol("joutiya.cspHash");

interface Buffering {
  chunks: Buffer[];
  size: number;
  head: unknown[] | null;
}

type Res = ServerResponse & { [STATE]?: Buffering | null };
type Callback = (error?: Error | null) => void;

const proto = ServerResponse.prototype as Res;
// Loosely typed originals: they are only re-applied with the arguments Node gave us.
type Loose = (this: ServerResponse, ...args: unknown[]) => unknown;
const original = {
  writeHead: proto.writeHead as unknown as Loose,
  write: proto.write as unknown as Loose,
  end: proto.end as unknown as Loose,
  flushHeaders: proto.flushHeaders as unknown as Loose,
};

function headerFromArgs(args: unknown[], name: string): unknown {
  const headers = args.find((arg) => typeof arg === "object" && arg !== null) as OutgoingHttpHeaders | unknown[] | undefined;
  if (!headers) return undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length - 1; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return headers[i + 1];
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** Decides once per response whether to buffer it. */
function state(res: Res, args: unknown[] = []): Buffering | null {
  if (res[STATE] !== undefined) return res[STATE];
  const marker = res.getHeader(INLINE_HASH_MARKER) ?? headerFromArgs(args, INLINE_HASH_MARKER);
  const type = String(res.getHeader("content-type") ?? headerFromArgs(args, "content-type") ?? "");
  const buffering = marker !== undefined && type.includes("text/html") && !res.headersSent;
  if (!buffering) res.removeHeader(INLINE_HASH_MARKER);
  res[STATE] = buffering ? { chunks: [], size: 0, head: null } : null;
  return res[STATE];
}

function toBuffer(chunk: unknown, encoding?: unknown): Buffer | null {
  if (chunk === undefined || chunk === null || typeof chunk === "function") return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
}

/** Applies the deferred writeHead, headers first so the CSP can still be rewritten. */
function applyHead(res: Res, buffered: Buffering): void {
  const head = buffered.head ?? [res.statusCode];
  const headers = head.find((arg) => typeof arg === "object" && arg !== null) as OutgoingHttpHeaders | unknown[] | undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length - 1; i += 2) res.setHeader(String(headers[i]), headers[i + 1] as string);
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) if (value !== undefined) res.setHeader(key, value);
  }
  const status = typeof head[0] === "number" ? head[0] : res.statusCode;
  const reason = typeof head[1] === "string" ? head[1] : undefined;
  res.removeHeader(INLINE_HASH_MARKER);
  res[STATE] = null;
  if (reason) original.writeHead.call(res, status, reason);
  else original.writeHead.call(res, status);
}

function tightenCsp(res: Res, body: Buffer): void {
  if (res.getHeader("content-encoding")) return;
  const html = body.toString("utf8");
  const hashes = inlineScriptHashes(html);
  for (const name of CSP_HEADERS) {
    const policy = res.getHeader(name);
    if (typeof policy === "string") res.setHeader(name, withScriptHashes(policy, hashes));
  }
}

/** Stops buffering: sends the head and what was buffered with the fallback CSP. */
function passThrough(res: Res, buffered: Buffering): void {
  applyHead(res, buffered);
  for (const chunk of buffered.chunks) original.write.call(res, chunk);
}

proto.writeHead = function writeHead(this: Res, ...args: unknown[]) {
  const buffered = state(this, args);
  if (!buffered) return original.writeHead.apply(this, args);
  buffered.head = args;
  return this;
} as typeof proto.writeHead;

proto.flushHeaders = function flushHeaders(this: Res) {
  if (state(this)) return;
  original.flushHeaders.call(this);
};

proto.write = function write(this: Res, chunk: unknown, encoding?: unknown, callback?: unknown) {
  const buffered = state(this);
  if (!buffered) return original.write.call(this, chunk, encoding, callback);
  const data = toBuffer(chunk, encoding);
  if (data) {
    buffered.chunks.push(data);
    buffered.size += data.length;
  }
  const done = (typeof encoding === "function" ? encoding : callback) as Callback | undefined;
  if (buffered.size > MAX_BUFFER) {
    passThrough(this, buffered);
    done?.();
    return true;
  }
  if (done) process.nextTick(done);
  return true;
} as typeof proto.write;

proto.end = function end(this: Res, chunk?: unknown, encoding?: unknown, callback?: unknown) {
  const buffered = state(this);
  if (!buffered) return original.end.call(this, chunk, encoding, callback);
  const data = toBuffer(chunk, encoding);
  if (data) buffered.chunks.push(data);
  const done = [chunk, encoding, callback].find((arg) => typeof arg === "function") as Callback | undefined;
  const body = Buffer.concat(buffered.chunks);
  try {
    tightenCsp(this, body);
  } catch {
    // Keep the fallback policy.
  }
  applyHead(this, buffered);
  return original.end.call(this, body, done);
} as typeof proto.end;

(globalThis as { __joutiyaCspHashHook?: boolean }).__joutiyaCspHashHook = true;
