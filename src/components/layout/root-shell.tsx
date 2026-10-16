import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { isRtl, LOCALE_TAGS, type Locale } from "@/config/site";
import { DEFAULT_LEGAL } from "@/config/legal";
import { Footer } from "@/components/legal/footer";
import type { PublicConfig } from "@/lib/config/public-types";
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
  children: ReactNode;
}

/**
 * <html> of the localized root layouts. Two root layouts share it: (public), static with a
 * hash-based CSP, and (private), dynamic with the request nonce and the runtime configuration.
 */
export async function RootShell({ locale, nonce, config, children }: RootShellProps) {
  const t = await getTranslations({ locale, namespace: "Nav" });
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
        <NextIntlClientProvider>
          <Providers dir={dir} config={config}>
            <SiteHeader locale={locale} />
            <main id="main" className="flex flex-1 flex-col">
              {children}
            </main>
            {/* Static default; the legal pages render the live config/legal values. */}
            <Footer publisher={DEFAULT_LEGAL.companyName} />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
