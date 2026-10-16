import { CircleCheck, Clock, PauseCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { PublicState } from "@/lib/listings/public";
import { cn } from "@/lib/utils";

// Why a public listing offers no contact action (D14: paused, sold and expired pages stay up with
// a banner; removed and purged ones are 404). Nothing for a published listing.

const ICONS = { paused: PauseCircle, sold: CircleCheck, expired: Clock } as const;

export function ListingStatusBanner({ state, className }: { state: PublicState; className?: string }) {
  const t = useTranslations("ListingPage.status");
  if (state === "published") return null;
  const Icon = ICONS[state];
  return (
    <div
      role="status"
      data-testid="listing-status"
      data-state={state}
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between",
        state === "sold" ? "border-success/30 bg-success-surface" : "border-warning/30 bg-warning-surface",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 size-5 shrink-0", state === "sold" ? "text-success" : "text-warning")} aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold">{t(`${state}.title`)}</p>
          <p className="text-sm text-foreground-muted text-pretty">{t(`${state}.body`)}</p>
        </div>
      </div>
      <Button asChild variant="outline" className="self-start sm:self-center">
        <Link href="/recherche">{t("browse")}</Link>
      </Button>
    </div>
  );
}
