import { useTranslations } from "next-intl";
import { DoorMark } from "@/components/feedback/door-mark";
import { Button } from "@/components/ui/button";
import type { AdFormat } from "@/config/ads";
import type { HousePromo as Promo } from "@/config/house-promos";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// House promotion (phase 6, D7): fills an ad slot whenever no ad runs. Laid out per format inside
// the slot's fixed height (never taller: the box must not change size when an ad replaces it).
// The whole box is the link's target (stretched link); the button text is the link's name.

const LAYOUT: Record<AdFormat, { box: string; mark: string; title: string; body: string; button: "sm" | "md" }> = {
  leaderboard: { box: "flex-row items-center gap-5 px-6", mark: "w-7 shrink-0", title: "truncate", body: "truncate text-sm", button: "sm" },
  banner: { box: "flex-row items-center gap-3 px-4", mark: "w-6 shrink-0", title: "line-clamp-2 text-sm", body: "max-sm:hidden truncate text-xs", button: "sm" },
  rectangle: { box: "flex-col items-center justify-center gap-3 px-5 text-center", mark: "w-9", title: "line-clamp-1", body: "line-clamp-2 text-sm max-w-xs", button: "md" },
  halfpage: { box: "flex-col items-center justify-center gap-5 px-8 text-center", mark: "w-16", title: "text-xl text-balance", body: "text-sm text-pretty", button: "md" },
};

export function HousePromo({ promo, format }: { promo: Promo; format: AdFormat }) {
  const t = useTranslations(`Ads.promos.${promo.id}`);
  const layout = LAYOUT[format];
  const row = layout.box.startsWith("flex-row");
  return (
    <div data-promo={promo.id} className={cn("flex size-full", layout.box)}>
      <DoorMark className={layout.mark} />
      <div className={cn("flex min-w-0 flex-col gap-1", row && "flex-1")}>
        <p className={cn("font-semibold", layout.title)}>{t("title")}</p>
        <p className={cn("text-foreground-muted", layout.body)}>{t("body")}</p>
      </div>
      <Button asChild variant="primary" size={layout.button} className={cn("after:absolute after:inset-0 after:content-['']", row && "shrink-0")}>
        <Link href={promo.href}>{t("cta")}</Link>
      </Button>
    </div>
  );
}
