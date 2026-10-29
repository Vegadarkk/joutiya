import "server-only";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SITE_NAME } from "@/config/site";
import { isFollowable, pageText, simhash, type Fingerprint, type PageFetch } from "./check";

// One GET of a guide source for the weekly checker (design guide-demarches G4). Redirects are
// followed by hand, at most MAX_REDIRECTS, and only to https URLs on OFFICIAL_HOSTS: a hop elsewhere
// is reported `offsite`, never fetched. A host resolving to a private, loopback or link-local
// address is refused (the VM's metadata endpoint stays out of reach even if an official domain is
// hijacked). Bodies are read up to MAX_BODY_BYTES.

export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;

// Several official sites refuse bare robot user agents: a browser-compatible string that still
// names the checker and its purpose.
export const CHECKER_USER_AGENT = `Mozilla/5.0 (compatible; ${SITE_NAME}LinkCheck/1.0; weekly check of the links of an admin procedures guide)`;

/** True for addresses no public site uses: private, loopback, link-local, CGNAT, unspecified. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (version === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("ff");
  }
  return true;
}

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}

const resolveHost = async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address);

async function readCapped(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(size, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.byteLength) break;
  }
  return bytes;
}

export interface FetchedPage extends PageFetch {
  fingerprint?: Fingerprint;
}

/** Fetches `url` (an official https URL), never throws. */
export async function fetchGuidePage(url: string, deps: FetchDeps = {}): Promise<FetchedPage> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolve = deps.resolve ?? resolveHost;
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isFollowable(current)) return { status: null, finalUrl: current.href, offsite: true, contentType: "", body: "" };
    try {
      const addresses = await resolve(current.hostname);
      if (addresses.length === 0 || addresses.some(isPrivateAddress)) return { status: null, finalUrl: current.href, contentType: "", body: "", error: "adresse IP non publique" };
    } catch (error) {
      return { status: null, finalUrl: current.href, contentType: "", body: "", error: `DNS : ${(error as Error).message}`.slice(0, 200) };
    }
    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS),
        headers: { "User-Agent": CHECKER_USER_AGENT, Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "Accept-Language": "fr,ar;q=0.8" },
      });
    } catch (error) {
      const name = (error as Error).name;
      return { status: null, finalUrl: current.href, contentType: "", body: "", error: name === "TimeoutError" ? "délai dépassé" : `réseau : ${(error as Error).message}`.slice(0, 200) };
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      try {
        current = new URL(location, current);
      } catch {
        return { status: response.status, finalUrl: current.href, contentType: "", body: "", error: "redirection invalide" };
      }
      continue;
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response);
    } catch (error) {
      return { status: null, finalUrl: current.href, contentType, body: "", error: `lecture : ${(error as Error).message}`.slice(0, 200) };
    }
    const textual = contentType.includes("html") || contentType.startsWith("text/");
    const body = textual ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : "";
    const page: FetchedPage = { status: response.status, finalUrl: current.href, contentType, body };
    if (response.ok) {
      const text = textual ? (contentType.includes("html") ? ((value) => `${value.title} ${value.text}`)(pageText(body)) : body) : "";
      page.fingerprint = textual
        ? { simhash: simhash(text), sha256: createHash("sha256").update(text.replace(/\d+/g, "")).digest("hex") }
        : { simhash: "", sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    return page;
  }
  return { status: null, finalUrl: current.href, contentType: "", body: "", error: "trop de redirections" };
}
