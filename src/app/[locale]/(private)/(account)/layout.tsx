import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { currentMember } from "@/lib/auth/current-user";

// Account area: a member session is required (§6 "layout : session obligatoire"). The guard only
// decides what renders; every API route re-checks the session itself. Nothing secret reaches the
// client from here: the pages fetch their data from /api/auth/me.

export default async function AccountLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  const user = await currentMember();
  if (!user) {
    // `x-pathname` (path + query of this request) is set by the proxy for private pages; without
    // it the person lands on the settings page after signing in.
    const next = (await headers()).get("x-pathname");
    redirect({ href: next ? { pathname: "/connexion", query: { next } } : "/connexion", locale });
  }
  return <>{children}</>;
}
