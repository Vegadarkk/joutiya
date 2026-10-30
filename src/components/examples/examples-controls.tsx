"use client";

import { EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { SwitchField } from "@/components/post/controls/switch";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { setExamplesHidden, useExamplesHidden } from "./use-examples";

// « Masquer les annonces exemples » (owner, 2026-10-30): the switch of /parametres, the button of an
// example's banner and the line that says they are hidden. A change applies at once (html attribute)
// and refreshes the page, so a search rendered on the server drops or brings back the examples.

function useExamplesChoice(): [boolean, (hidden: boolean) => void] {
  const t = useTranslations("Examples");
  const router = useRouter();
  const hidden = useExamplesHidden();
  const choose = (next: boolean) => {
    setExamplesHidden(next);
    toast.success(t(next ? "hiddenToast" : "shownToast"));
    router.refresh();
  };
  return [hidden, choose];
}

export function ExamplesSwitch({ className }: { className?: string }) {
  const t = useTranslations("Examples");
  const [hidden, choose] = useExamplesChoice();
  return <SwitchField label={t("label")} hint={t("hint")} checked={hidden} onCheckedChange={choose} className={className} />;
}

/** On an example listing or shop: hides the others (the page itself stays, it was asked for). */
export function HideExamplesButton({ className }: { className?: string }) {
  const t = useTranslations("Examples");
  const [hidden, choose] = useExamplesChoice();
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => choose(!hidden)} data-testid="examples-toggle" className={cn("self-start", className)}>
      {hidden ? null : <EyeOff aria-hidden="true" />}
      {t(hidden ? "show" : "hide")}
    </Button>
  );
}

/** Above results that may have lost their examples: says so, with the way back. Nothing otherwise. */
export function ExamplesHiddenNotice({ className }: { className?: string }) {
  const t = useTranslations("Examples");
  const [hidden, choose] = useExamplesChoice();
  if (!hidden) return null;
  return (
    <p role="status" data-testid="examples-hidden" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground-muted", className)}>
      <EyeOff className="size-4 shrink-0" aria-hidden="true" />
      <span>{t("hiddenNotice")}</span>
      <Button type="button" variant="link" size="sm" onClick={() => choose(false)} className="font-medium">
        {t("show")}
      </Button>
    </p>
  );
}
