import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { RootShell } from "@/components/layout/root-shell";
import { rootMetadata } from "@/lib/i18n/metadata";

// Private pages (auth, account, Pro): dynamic rendering with the per-request nonce (§1, §6).
// Session guards arrive with phase 2; this layout is not an authorization barrier.

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
    <RootShell locale={locale} nonce={nonce}>
      {children}
    </RootShell>
  );
}
