"use client";

import { useTranslations } from "next-intl";
import { DoorMark } from "@/components/feedback/door-mark";
import { Button } from "@/components/ui/button";
import { SITE_NAME } from "@/config/site";
import { cn } from "@/lib/utils";
import { useConsent } from "./consent-provider";

// First layer of the consent (phase 6, D2): non-blocking, no cookie wall. Bottom sheet on phones,
// a card at the bottom start corner from sm up. Accept, refuse and customise have the same size and
// style (CNIL: refusing is as easy as accepting). The text names the recipient and asks for the
// express consent to the transfer to the United States (loi 09-08, art. 44).

const buttonClassName = "h-11 px-2 text-sm";

export function ConsentBanner() {
  const t = useTranslations("Consent");
  const { save, openPanel } = useConsent();
  return (
    <section
      aria-labelledby="consent-banner-title"
      data-testid="consent-banner"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex flex-col gap-4 border-t-2 border-structure bg-surface p-5 shadow-2xl shadow-bab-950/25 dark:border-bab-600",
        "sm:inset-x-auto sm:start-4 sm:bottom-4 sm:w-[27rem] sm:rounded-lg sm:border sm:border-t-4",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200",
      )}
    >
      <div className="flex items-start gap-3">
        <DoorMark className="mt-0.5 w-7 shrink-0" />
        <div className="flex flex-col gap-1.5">
          <h2 id="consent-banner-title" className="font-semibold text-balance">
            {t("bannerTitle")}
          </h2>
          <p className="text-sm text-foreground-muted text-pretty">{t("bannerBody", { brand: SITE_NAME })}</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button type="button" variant="outline" className={buttonClassName} onClick={() => save(true, true)}>
          {t("acceptAll")}
        </Button>
        <Button type="button" variant="outline" className={buttonClassName} onClick={() => save(false, false)}>
          {t("refuseAll")}
        </Button>
        <Button type="button" variant="outline" className={buttonClassName} onClick={openPanel}>
          {t("customize")}
        </Button>
      </div>
    </section>
  );
}
