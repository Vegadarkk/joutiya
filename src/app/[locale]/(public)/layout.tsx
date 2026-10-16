import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { RootShell } from "@/components/layout/root-shell";
import { PUBLIC_CLIENT_NAMESPACES } from "@/i18n/client-messages";
import { rootMetadata } from "@/lib/i18n/metadata";

// Public anonymous pages: static or ISR, hash-based CSP, cacheable by Cloudflare (§1, §6).

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return hasLocale(routing.locales, locale) ? rootMetadata(locale) : {};
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1e1f" },
  ],
};

export default async function PublicLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // The browser gets only the messages of the public client islands (src/i18n/client-messages.ts).
  return (
    <RootShell locale={locale} clientNamespaces={PUBLIC_CLIENT_NAMESPACES}>
      {children}
    </RootShell>
  );
}
