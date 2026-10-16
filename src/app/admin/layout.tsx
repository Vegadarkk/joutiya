import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ThemeSync } from "@/components/layout/theme";
import { ThemeScript } from "@/components/layout/theme-script";
import { Toaster } from "@/components/ui/toaster";
import { ACCESS_JWT_HEADER, verifyAccessJwt } from "@/lib/auth/access-jwt";
import { serverEnv } from "@/lib/env";
import { readex } from "@/lib/fonts";
import { SITE_VIEWPORT } from "@/lib/i18n/metadata";
import "@/styles/globals.css";

// Back office, served only on the admin host (proxy.ts rewrites it to /admin): French only,
// dynamic, nonce CSP. This layout checks the Cloudflare Access token (first lock, §6); the staff
// session decides between /connexion and the (protected) group, and every API route re-checks.

export const metadata: Metadata = {
  title: { default: "Back-office", template: "%s · Back-office Joutiya" },
  robots: { index: false, follow: false },
  // Same file as the public pages (src/lib/i18n/metadata.ts), served as is on the admin host.
  icons: { icon: "/brand/joutiya-icon.svg" },
};

export const viewport = SITE_VIEWPORT;

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
        <Toaster dir="ltr" />
      </body>
    </html>
  );
}
