"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// "Partager" beside the favourite button of a listing (UX journeys counter-review, 8): the share
// sheet where the browser has one (phones), the link copied elsewhere, the button saying which.

const noSubscription = () => () => {};
const shareSheetExists = () => typeof navigator.share === "function";

export function ShareButton({ url, title, className }: { url: string; title: string; className?: string }) {
  const t = useTranslations("ListingPage.share");
  const [copied, setCopied] = useState(false);
  // False on the server and at hydration, read from the browser right after.
  const canShare = useSyncExternalStore(noSubscription, shareSheetExists, () => false);

  async function share() {
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Cancelled share or blocked clipboard: the address bar still has the link.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void share()}
      data-testid="share-button"
      className={cn(
        "inline-flex h-11 shrink-0 items-center gap-2 rounded-md border border-border-strong bg-surface px-4 text-base font-medium text-foreground",
        "transition-[background-color,scale] duration-150 ease-door hover:bg-surface-muted active:scale-[0.98]",
        className,
      )}
    >
      {copied ? <Check className="size-5 text-success" aria-hidden="true" /> : <Share2 className="size-5" aria-hidden="true" />}
      <span aria-live="polite">{copied ? t("copied") : canShare ? t("share") : t("copyLink")}</span>
    </button>
  );
}
