import type { ReactNode } from "react";
import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { Container } from "@/components/layout/container";
import { MessagesShell } from "@/components/messages/messages-shell";
import { pageLocale } from "@/i18n/params";

// /messages (design phase-5 D2): the list and the open thread share this layout, so the list keeps
// its state and its live updates while the person moves from one conversation to another.

export default async function MessagesLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="flex flex-1 flex-col px-0 sm:px-0 lg:px-6 lg:py-6">
      <FrenchOnlyNotice className="lg:mb-4" />
      {/* useSearchParams (the archived view) needs a Suspense boundary (design §8). */}
      <Suspense fallback={<div className="h-[calc(100dvh-4rem)] md:h-[calc(100dvh-5rem)] lg:h-[calc(100dvh-8rem)]" />}>
        <MessagesShell>{children}</MessagesShell>
      </Suspense>
    </Container>
  );
}
