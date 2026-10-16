"use client";

import { Globe } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { Link, usePathname } from "@/i18n/navigation";
import { LOCALES, type Locale } from "@/config/site";
import { cn } from "@/lib/utils";

// The same page in another language, query string included: search filters, ?next= of the
// challenge page and the unsubscribe token live in the URL. The items read the query only once the
// menu opens (Radix mounts the content on open): useSearchParams never runs while a static page
// prerenders, so the header needs no Suspense boundary.

export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("Locale");
  const current = useLocale() as Locale;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className={cn(
          "inline-flex h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-foreground hover:bg-surface-muted",
          "data-[state=open]:bg-surface-muted",
          className,
        )}
        aria-label={t("label")}
      >
        <Globe className="size-4" aria-hidden="true" />
        <span>{t(`short.${current}`)}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(
            "z-50 min-w-44 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <LocaleItems current={current} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function LocaleItems({ current }: { current: Locale }) {
  const t = useTranslations("Locale");
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const href = query ? `${pathname}?${query}` : pathname;
  return LOCALES.map((locale) => (
    <DropdownMenu.Item key={locale} asChild>
      <Link
        href={href}
        locale={locale}
        lang={locale === "rif" ? "rif-Latn" : locale}
        aria-current={locale === current ? "true" : undefined}
        className={cn(
          "flex min-h-11 cursor-pointer items-center justify-between gap-6 rounded-sm px-3 py-2 text-sm outline-none",
          "data-[highlighted]:bg-surface-muted aria-[current=true]:font-semibold",
        )}
      >
        {t(`names.${locale}`)}
        {locale === current ? <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" /> : null}
      </Link>
    </DropdownMenu.Item>
  ));
}
