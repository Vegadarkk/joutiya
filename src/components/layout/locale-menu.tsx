"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { Link } from "@/i18n/navigation";
import { LOCALES, type Locale } from "@/config/site";
import { cn } from "@/lib/utils";
import { useSamePageHref } from "./same-page-href";

// The language menu: its own chunk, loaded by locale-switcher.tsx when the visitor reaches for the
// trigger, so the dropdown primitives stay out of every page's first JavaScript. It mounts open
// (the click that loaded it asked for it).

export interface LocaleMenuProps {
  /** The trigger's look, name and content, shared with the plain button shown until this chunk runs. */
  triggerClassName: string;
  label: string;
  children: ReactNode;
}

export default function LocaleMenu({ triggerClassName, label, children }: LocaleMenuProps) {
  const t = useTranslations("Locale");
  const current = useLocale() as Locale;
  const href = useSamePageHref();
  return (
    <DropdownMenu.Root modal={false} defaultOpen>
      <DropdownMenu.Trigger className={triggerClassName} aria-label={label}>
        {children}
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
          {LOCALES.map((locale) => (
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
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
