import { useTranslations } from "next-intl";
import { DoorMark } from "@/components/feedback/door-mark";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Reserved advertising space (Google Ads slots arrive later, no script yet): the height is held now
// so the future ad never shifts the page (CLS), and a house promotion fills it meanwhile.

/** Reserved height per slot: medium rectangle (300x250) or large mobile banner (320x100). */
export const AD_SLOTS = {
  /** Beside the listing, lg and up. */
  "listing-aside": "rectangle",
  /** After the listing's text, below lg. */
  "listing-bottom": "rectangle",
  /** Under the grid of a profile. */
  "profile-bottom": "banner",
} as const;
export type AdSlotId = keyof typeof AD_SLOTS;

export function AdSlot({ slot, className }: { slot: AdSlotId; className?: string }) {
  const t = useTranslations("ListingPage.ad");
  const tall = AD_SLOTS[slot] === "rectangle";
  return (
    <aside
      data-ad-slot={slot}
      aria-label={t("label")}
      className={cn(
        "flex overflow-hidden rounded-lg bg-surface-muted",
        tall ? "flex-col items-center justify-center gap-3 p-6 text-center" : "flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between",
        tall ? "min-h-[250px]" : "min-h-[100px]",
        className,
      )}
    >
      <div className={cn("flex gap-3", tall ? "flex-col items-center" : "items-center")}>
        <DoorMark className={tall ? "w-12" : "w-9 shrink-0"} />
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-balance">{t("title")}</p>
          <p className="text-sm text-foreground-muted text-pretty">{t("body")}</p>
        </div>
      </div>
      <Button asChild variant="primary" className={tall ? undefined : "shrink-0"}>
        <Link href="/deposer">{t("cta")}</Link>
      </Button>
    </aside>
  );
}
