import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ThemeSync } from "@/components/layout/theme";
import { ThemeScript } from "@/components/layout/theme-script";
import { ACCESS_JWT_HEADER, verifyAccessJwt } from "@/lib/auth/access-jwt";
import { serverEnv } from "@/lib/env";
import { readex } from "@/lib/fonts";
import "@/styles/globals.css";

// Back office, served only on the admin host (proxy.ts rewrites it to /admin): French only,
// dynamic, nonce CSP. Phase 1 checks the Cloudflare Access token; the staff session and roles
// (requireStaff) arrive with phase 2.

export const metadata: Metadata = {
  title: { default: "Back-office", template: "%s · Back-office Joutiya" },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const env = serverEnv();
  if (env.APP_ENV !== "dev" || env.CF_ACCESS_AUD) {
    const identity = await verifyAccessJwt(requestHeaders.get(ACCESS_JWT_HEADER), {
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN ?? "",
      audience: env.CF_ACCESS_AUD ?? "",
    });
    if (!identity) notFound();
  }
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  return (
    <html lang="fr-MA" dir="ltr" className={readex.variable} suppressHydrationWarning>
      <body className="min-h-dvh bg-surface-muted antialiased">
        <ThemeScript nonce={nonce} />
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
