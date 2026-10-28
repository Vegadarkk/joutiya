"use client";

import { useTranslations } from "next-intl";
import { quietLinkClassName } from "@/components/ui/text-link";
import { cn } from "@/lib/utils";
import { useConsent } from "./consent-provider";

/** "Gérer mes cookies" in the footer of every page (D2): reopens the consent panel. */
export function ConsentLink({ className }: { className?: string }) {
  const t = useTranslations("Consent");
  const { openPanel } = useConsent();
  return (
    <button type="button" onClick={openPanel} className={cn("cursor-pointer text-start", quietLinkClassName, className)}>
      {t("footerLink")}
    </button>
  );
}
