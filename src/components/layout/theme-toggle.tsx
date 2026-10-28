"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { useTheme } from "./theme";

const OPTIONS = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

const subscribe = () => () => {};

/** Three-way segmented control; renders neutral until hydrated (the stored choice is client-only). */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("Theme");
  const { theme, setTheme } = useTheme();
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return (
    <div role="radiogroup" aria-label={t("label")} className={cn("inline-flex rounded-md border border-border p-0.5", className)}>
      {OPTIONS.map(({ value, icon: Icon }) => {
        const active = hydrated && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t(value)}
            title={t(value)}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex size-11 items-center justify-center rounded-sm text-foreground-muted transition-[background-color,color,box-shadow,scale] duration-150 ease-door active:scale-[0.98]",
              "hover:text-foreground aria-checked:bg-surface aria-checked:text-foreground aria-checked:shadow-sm",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
