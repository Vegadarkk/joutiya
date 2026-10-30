"use client";

import { Suspense, useId, useState } from "react";
import { Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { SWITCHABLE_LOCALES, type Locale } from "@/config/site";
import { cn } from "@/lib/utils";
import type { LocaleMenuProps } from "./locale-menu";
import { lazyIsland } from "./lazy-island";
import { useSamePageHref } from "./same-page-href";

// Header language switcher. The menu (locale-menu.tsx, dropdown primitives) is a separate chunk:
// a plain trigger renders first, its download starts when the pointer or the focus reaches it, and
// the click opens the menu once it has arrived. If the chunk cannot be loaded, plain links stand in.

const loadMenu = () => import("./locale-menu");
const LocaleMenu = lazyIsland(loadMenu, LocaleLinks);

function warmMenu(): void {
  void loadMenu().catch(() => undefined);
}

export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("Locale");
  const current = useLocale() as Locale;
  const [requested, setRequested] = useState(false);
  const triggerClassName = cn(
    "inline-flex h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-foreground transition-[background-color,scale] duration-150 ease-door hover:bg-surface-muted active:scale-[0.98]",
    "data-[state=open]:bg-surface-muted",
    className,
  );
  // The accessible name starts with the visible code (WCAG 2.5.3): "FR, Langue".
  const label = t("trigger", { short: t(`short.${current}`), label: t("label") });
  const content = (
    <>
      <Globe className="size-4" aria-hidden="true" />
      <span>{t(`short.${current}`)}</span>
    </>
  );
  const trigger = (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={false}
      aria-label={label}
      className={triggerClassName}
      onPointerEnter={warmMenu}
      onFocus={warmMenu}
      onClick={() => setRequested(true)}
    >
      {content}
    </button>
  );
  if (!requested) return trigger;
  return (
    <Suspense fallback={trigger}>
      <LocaleMenu triggerClassName={triggerClassName} label={label}>
        {content}
      </LocaleMenu>
    </Suspense>
  );
}

/**
 * The language menu without its chunk (download failed): the same trigger toggles a plain list of
 * the three links, open at first like the menu (the click asked for it). Escape closes it.
 */
export function LocaleLinks({ triggerClassName, label, children }: LocaleMenuProps) {
  const t = useTranslations("Locale");
  const current = useLocale() as Locale;
  const href = useSamePageHref();
  const [open, setOpen] = useState(true);
  const listId = useId();
  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button type="button" aria-expanded={open} aria-controls={listId} aria-label={label} data-state={open ? "open" : "closed"} className={triggerClassName} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {open ? (
        <ul id={listId} className="absolute end-0 top-full z-50 mt-1.5 min-w-44 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10">
          {SWITCHABLE_LOCALES.map((locale) => (
            <li key={locale}>
              <Link
                href={href}
                locale={locale}
                lang={locale === "rif" ? "rif-Latn" : locale}
                aria-current={locale === current ? "true" : undefined}
                className="flex min-h-11 items-center justify-between gap-6 rounded-sm px-3 py-2 text-sm outline-none hover:bg-surface-muted focus-visible:bg-surface-muted aria-[current=true]:font-semibold"
              >
                {t(`names.${locale}`)}
                {locale === current ? <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" /> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
