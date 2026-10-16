import "server-only";
import { serverEnv, type ServerEnv } from "@/lib/env";

// Origin check (§6 CSRF): mandatory on every mutation, absent or foreign Origin = 403. The API
// sends no Access-Control-Allow-* header, so cross-origin callers are refused by the browser too.

export type HostKind = "public" | "admin";

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Which host served this request: the back office (ADMIN_HOST) or the public site. */
export function hostKind(headers: Headers, env: ServerEnv = serverEnv()): HostKind {
  const admin = normalizeHost(env.ADMIN_HOST);
  return admin !== "" && normalizeHost(headers.get("host")) === admin ? "admin" : "public";
}

/** Origin the browser sends from pages of this host. */
export function expectedOrigin(kind: HostKind, env: ServerEnv = serverEnv()): string {
  const site = new URL(env.SITE_URL);
  if (kind === "public" || !env.ADMIN_HOST) return site.origin;
  return `${site.protocol}//${normalizeHost(env.ADMIN_HOST)}${site.port ? `:${site.port}` : ""}`;
}

export function isSameOrigin(headers: Headers, kind: HostKind, env: ServerEnv = serverEnv()): boolean {
  const origin = headers.get("origin");
  return origin !== null && origin === expectedOrigin(kind, env);
}
