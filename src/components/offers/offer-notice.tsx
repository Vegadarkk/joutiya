"use client";

import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { SITE_NAME } from "@/config/site";
import { cn } from "@/lib/utils";

// The neutral-host notice of every offer form and card (Carte vivante lot 5): an accepted offer is
// no sale and no payment, the members settle both between themselves, never a deposit.

export function OfferNotice({ className }: { className?: string }) {
  const t = useTranslations("Offers.listing");
  return (
    <p className={cn("flex gap-2 text-xs text-foreground-muted text-pretty", className)} data-testid="offer-notice">
      <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" aria-hidden="true" />
      <span>
        {t("notice")} {t("safety", { site: SITE_NAME })}
      </span>
    </p>
  );
}
