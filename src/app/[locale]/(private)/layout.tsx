import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { RootShell } from "@/components/layout/root-shell";
import { currentUser, renderUserPrivate } from "@/lib/auth/current-user";
import { sessionSummary } from "@/lib/auth/summary";
import { publicConfig } from "@/lib/config/public";
import { getFlags } from "@/lib/config/runtime";
import type { SessionSummary } from "@/lib/contracts/auth";
import { rootMetadata, SITE_VIEWPORT } from "@/lib/i18n/metadata";

// Private pages (auth, account, Pro): dynamic rendering with the per-request nonce (§1, §6), and
// the runtime browser configuration (Turnstile, Google, Firebase) handed to the client from here
// (§2: one image for staging and prod). Not an authorization barrier: (account)/layout.tsx and
// every API route run their own guards.

/**
 * What GET /api/auth/me would answer for this request, so the header and the account pages render
 * the signed-in state on first paint instead of after a round trip. null = anonymous; undefined
 * when the summary cannot be built (the browser then asks /api/auth/me itself).
 */
async function initialSession(): Promise<SessionSummary | null | undefined> {
  const user = await currentUser();
  if (!user) return null;
  try {
    return await sessionSummary(user, renderUserPrivate);
  } catch {
    return undefined;
  }
}

export const viewport = SITE_VIEWPORT;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  return { ...(await rootMetadata(locale)), robots: { index: false, follow: false } };
}

export default async function PrivateLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <RootShell locale={locale} nonce={nonce} config={publicConfig(undefined, await getFlags())} initialSession={await initialSession()}>
      {children}
    </RootShell>
  );
}
