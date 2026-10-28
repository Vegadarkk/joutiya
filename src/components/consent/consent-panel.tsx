"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { SwitchField } from "@/components/post/controls/switch";
import { Button } from "@/components/ui/button";
import { textLinkClassName } from "@/components/ui/text-link";
import { SITE_NAME } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useAdsConfig, useConsent } from "./consent-provider";

// Second layer (phase 6, D2): one switch per purpose, nothing pre-ticked on a first choice, the
// exempt cookies listed apart. Without any tracker (ads off) it says so and offers nothing to
// accept: no consent is needed then (CNIL).

export function ConsentPanel() {
  const t = useTranslations("Consent");
  const { choice, save, closePanel } = useConsent();
  const ads = useAdsConfig();
  const [allowAds, setAllowAds] = useState(choice?.ads ?? false);
  const [allowPerso, setAllowPerso] = useState(choice?.perso ?? false);
  // Unknown until the configuration loads: the trackers' switches wait for it.
  const trackers = ads === null ? null : ads.mode !== "off";
  const cookiesLink = (chunks: React.ReactNode) => (
    <Link href="/legal/cookies" onClick={closePanel} className={textLinkClassName}>
      {chunks}
    </Link>
  );

  return (
    <Dialog.Root open onOpenChange={(open) => !open && closePanel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="consent-panel"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col overflow-y-auto rounded-t-xl border-t-4 border-structure bg-surface shadow-2xl shadow-bab-950/25 outline-none dark:border-bab-600",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=open]:slide-in-from-bottom-2",
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-6">
            <Dialog.Title className="text-xl font-semibold text-balance">{t("panelTitle")}</Dialog.Title>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" className="-me-2 -mt-2" aria-label={t("close")}>
                <X aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="px-6 pt-2 text-sm text-foreground-muted text-pretty">
            {trackers === false ? t("noTrackers", { brand: SITE_NAME }) : t("panelIntro")}
          </Dialog.Description>

          {trackers ? (
            <div className="mx-6 mt-5 flex flex-col divide-y divide-border border-y border-border">
              <SwitchField
                label={t("adsLabel")}
                hint={t("adsHint")}
                checked={allowAds}
                onCheckedChange={(checked) => {
                  setAllowAds(checked);
                  if (!checked) setAllowPerso(false);
                }}
                className="py-4"
              />
              <SwitchField label={t("persoLabel")} hint={t("persoHint")} checked={allowPerso} disabled={!allowAds} onCheckedChange={setAllowPerso} className="py-4" />
            </div>
          ) : null}

          <div className="mx-6 mt-5 flex flex-col gap-1 rounded-md bg-surface-muted px-4 py-3 text-sm">
            <p className="font-medium">{t("necessaryTitle")}</p>
            <p className="text-foreground-muted text-pretty">{t.rich("necessaryBody", { link: cookiesLink })}</p>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-2 border-t border-border px-6 py-4 sm:flex-row sm:justify-end">
            {trackers ? (
              <>
                <Button type="button" variant="outline" onClick={() => save(false, false)}>
                  {t("refuseAll")}
                </Button>
                <Button type="button" variant="primary" onClick={() => save(allowAds, allowPerso)}>
                  {t("save")}
                </Button>
              </>
            ) : (
              <Dialog.Close asChild>
                <Button type="button" variant="outline">
                  {t("close")}
                </Button>
              </Dialog.Close>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
