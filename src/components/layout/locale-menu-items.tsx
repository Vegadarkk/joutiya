"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { Link } from "@/i18n/navigation";
import { SWITCHABLE_LOCALES, type Locale } from "@/config/site";
import { cn } from "@/lib/utils";
import { useSamePageHref } from "./same-page-href";

// The other languages as items of the header menus (visitor and account) below md, where the
// language pill is not in the header: the footer has one, but the map home has no footer on a phone
// (UX journeys counter-review, 10). Same links as locale-menu.tsx: the page on screen, in that language.

export function LocaleMenuItems({ itemClassName, className }: { itemClassName: string; className?: string }) {
  const t = useTranslations("Locale");
  const current = useLocale() as Locale;
  const href = useSamePageHref();
  const others = SWITCHABLE_LOCALES.filter((locale) => locale !== current);
  if (others.length === 0) return null;
  return (
    <>
      <DropdownMenu.Separator className={cn("my-1 h-px bg-border", className)} />
      {others.map((locale) => (
        <DropdownMenu.Item key={locale} asChild>
          <Link href={href} locale={locale} lang={locale === "rif" ? "rif-Latn" : locale} className={cn(itemClassName, className)}>
            <Languages aria-hidden="true" />
            {t(`names.${locale}`)}
          </Link>
        </DropdownMenu.Item>
      ))}
    </>
  );
}
