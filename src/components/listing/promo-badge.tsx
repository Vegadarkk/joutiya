import { Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import type { PromoKind } from "@/lib/contracts/catalog-core";
import { cn } from "@/lib/utils";

// The mark of a running promotion (catalogue §4): « Promo −20 % », « Soldes −30 % », « Vente
// flash ». The percentage is against the struck-out price only (art. 54): a listing younger than 30
// days has none, so its badge names the kind alone.

export function PromoBadge({ kind, percent, size = "sm", className }: { kind: PromoKind; percent: number; size?: "sm" | "lg"; className?: string }) {
  const t = useTranslations("ListingCard");
  return (
    <span
      data-testid="promo-badge"
      data-kind={kind}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm font-semibold whitespace-nowrap",
        kind === "flash" ? "bg-primary text-primary-foreground" : "bg-danger text-danger-foreground",
        size === "lg" ? "px-2 py-0.5 text-sm" : "px-1.5 py-0.5 text-xs",
        className,
      )}
    >
      {kind === "flash" ? <Zap className={size === "lg" ? "size-4" : "size-3.5"} aria-hidden="true" /> : null}
      {t(`promo.${kind}`)}
      {percent > 0 ? <span className="tabular-nums">{t("percentOff", { percent })}</span> : null}
    </span>
  );
}
