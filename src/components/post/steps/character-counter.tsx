"use client";

import { useNumbersTranslations } from "@/i18n/numbers";
import { cn } from "@/lib/utils";

/** "12 / 70 caractères" with a live hint while the minimum is not reached. */
export function CharacterCounter({ count, min, max }: { count: number; min: number; max: number }) {
  const t = useNumbersTranslations("Listing.fields");
  const over = count > max;
  const under = count < min;
  return (
    <p aria-live="polite" className={cn("flex items-center justify-between gap-3 text-sm tabular-nums", over ? "text-danger" : "text-foreground-muted")}>
      <span>{under && count > 0 ? t("charactersMin", { count: min - count }) : ""}</span>
      <span>{t("characters", { count, max })}</span>
    </p>
  );
}
