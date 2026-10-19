import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { HELP_PAGE_CLIENT_NAMESPACES, PUBLIC_CLIENT_NAMESPACES, pickMessages } from "@/i18n/client-messages";
import { pageLocale } from "@/i18n/params";

// Help centre (design phase-5 D25): the public client messages plus the search box and assistant
// widget ones (src/i18n/client-messages.ts). A nested provider replaces, never merges.

export default async function HelpLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  const messages = pickMessages(await getMessages({ locale }), [...PUBLIC_CLIENT_NAMESPACES, ...HELP_PAGE_CLIENT_NAMESPACES]);
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
