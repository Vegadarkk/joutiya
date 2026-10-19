import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { isRtl, LOCALE_TAGS, type Locale } from "@/config/site";
import { Footer } from "@/components/legal/footer";
import type { PublicConfig } from "@/lib/config/public-types";
import type { SessionSummary } from "@/lib/contracts/auth";
import { getLegalConfig } from "@/lib/legal/config";
import { pickMessages } from "@/i18n/client-messages";
import { readex, tarifitFallback } from "@/lib/fonts";
import { Providers } from "./providers";
import { SiteHeader } from "./site-header";
import { ThemeScript } from "./theme-script";
import "@/styles/globals.css";

interface RootShellProps {
  locale: Locale;
  /** Private layout only: the request nonce for inline and third-party scripts. */
  nonce?: string;
  /** Private layout only: runtime browser configuration (public pages fetch /api/config instead). */
  config?: PublicConfig;
  /** Private layout only: the session of this request (null = anonymous), so the header renders it on first paint. */
  initialSession?: SessionSummary | null;
  /** The message namespaces the browser receives; the whole catalog when omitted (private layout). */
  clientNamespaces?: readonly string[];
  children: ReactNode;
}

/**
 * <html> of the localized root layouts. Two root layouts share it: (public), static with a
 * hash-based CSP, and (private), dynamic with the request nonce and the runtime configuration.
 */
export async function RootShell({ locale, nonce, config, initialSession, clientNamespaces, children }: RootShellProps) {
  const t = await getTranslations({ locale, namespace: "Nav" });
  const messages = clientNamespaces ? pickMessages(await getMessages({ locale }), clientNamespaces) : undefined;
  // Live config/legal (cached 5 minutes); it reads no request data, so (public) stays static (ISR).
  const { companyName } = await getLegalConfig();
  const dir = isRtl(locale) ? "rtl" : "ltr";
  return (
    <html lang={LOCALE_TAGS[locale]} dir={dir} className={`${readex.variable} ${tarifitFallback.variable}`} suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col antialiased">
        <ThemeScript nonce={nonce} />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:shadow-lg"
        >
          {t("skip")}
        </a>
        <NextIntlClientProvider messages={messages}>
          <Providers dir={dir} config={config} initialSession={initialSession}>
            <SiteHeader locale={locale} />
            <main id="main" className="flex flex-1 flex-col">
              {children}
            </main>
            <Footer publisher={companyName} />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
