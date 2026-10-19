import type { ReactNode } from "react";
import { headers } from "next/headers";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { TransfersReconsent } from "@/components/auth/transfers-reconsent";
import { Container } from "@/components/layout/container";
import { redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { needsTransfersReconsent } from "@/lib/auth/consents";
import { currentMember, renderUserPrivate } from "@/lib/auth/current-user";
import { getLegalConfig } from "@/lib/legal/config";

// Account area: a member session is required (§6 "layout : session obligatoire"). The guard only
// decides what renders; every API route re-checks the session itself. Nothing secret reaches the
// client from here: the pages fetch their data from /api/auth/me.
//
// Transfers consent gate (design D12): a member whose stored consent is not the current text gets
// the re-consent panel instead of any account page. The API does not check it, on purpose: every
// write path a member reaches sits behind these pages, a check per mutation would cost one more
// Firestore read each (Spark quota), and only test accounts predate the 2026-10-19 version.

export default async function AccountLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  const user = await currentMember();
  if (!user) {
    // `x-pathname` (path + query of this request) is set by the proxy for private pages; without
    // it the person lands on the settings page after signing in.
    const next = (await headers()).get("x-pathname");
    redirect({ href: next ? { pathname: "/connexion", query: { next } } : "/connexion", locale });
    return null; // not reached: redirect() throws
  }
  // Same read as the private layout's session summary (cached per request).
  if (needsTransfersReconsent(await renderUserPrivate(user.uid))) {
    const legal = await getLegalConfig();
    return (
      // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
      <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-2xl py-10 lg:py-14">
        <FrenchOnlyNotice className="mb-8" />
        <TransfersReconsent dpo={legal.dpoContact} />
      </Container>
    );
  }
  return <>{children}</>;
}
