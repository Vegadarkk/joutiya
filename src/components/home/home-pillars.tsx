import { HandCoins, MapPinned, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// The three promises of the home page (design D21): free to post, near you, safe exchanges. Three
// columns under the listings of the list view; a quiet stacked list at the foot of the home map's
// panel (Carte vivante, lot 3).

const PILLARS = [
  { key: "free", icon: HandCoins },
  { key: "near", icon: MapPinned },
  { key: "safe", icon: ShieldCheck },
] as const;

export function HomePillars({ compact = false, className }: { compact?: boolean; className?: string }) {
  const t = useTranslations("Home.pillars");
  return (
    <ul data-testid={compact ? "home-pillars-compact" : "home-pillars"} className={cn(compact ? "flex flex-col gap-3" : "grid gap-8 sm:grid-cols-3", className)}>
      {PILLARS.map(({ key, icon: Icon }) => (
        <li key={key} className={cn("flex", compact ? "gap-3" : "gap-4")}>
          <span
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300",
              compact ? "size-9" : "size-11",
            )}
          >
            <Icon className={compact ? "size-4" : "size-5"} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className={cn("font-semibold", compact && "text-sm")}>{t(`${key}.title`)}</h2>
            <p className={cn("text-foreground-muted", compact ? "text-xs" : "mt-1 text-sm")}>{t(`${key}.body`)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
