"use client";

import { lazy, Suspense, useState } from "react";
import { Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/config/site";
import { cn } from "@/lib/utils";

// Header language switcher. The menu (locale-menu.tsx, dropdown primitives) is a separate chunk:
// a plain trigger renders first, its download starts when the pointer or the focus reaches it, and
// the click opens the menu once it has arrived.

const loadMenu = () => import("./locale-menu");
const LocaleMenu = lazy(loadMenu);

function warmMenu(): void {
  void loadMenu().catch(() => undefined);
}

export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("Locale");
  const current = useLocale() as Locale;
  const [requested, setRequested] = useState(false);
  const triggerClassName = cn(
    "inline-flex h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-foreground hover:bg-surface-muted",
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
