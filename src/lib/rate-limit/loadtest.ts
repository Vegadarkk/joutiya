import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

// Load test bypass (phase 6, D17): k6 sends 40 pages and 50 searches a second from one runner IP,
// far over the per-IP limits. A request whose x-joutiya-loadtest header equals
// LOADTEST_BYPASS_SECRET skips the page and search limiters, in staging only: the variable is
// refused at startup in production, and it is set on the VM for the test and removed after
// (docs/lancement/charge-procedure.md). The Cloudflare side is a temporary Skip rule on the same header.

export const LOADTEST_HEADER = "x-joutiya-loadtest";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** True only in staging, with the secret set and sent exactly (compared in constant time). */
export function isLoadTestRequest(headers: Headers, env: Pick<ReturnType<typeof serverEnv>, "APP_ENV" | "LOADTEST_BYPASS_SECRET"> = serverEnv()): boolean {
  const secret = env.LOADTEST_BYPASS_SECRET;
  if (env.APP_ENV !== "staging" || !secret) return false;
  const sent = headers.get(LOADTEST_HEADER);
  return sent !== null && timingSafeEqual(digest(sent), digest(secret));
}
