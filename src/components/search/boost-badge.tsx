"use client";

import { useId } from "react";
import { ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { Popover } from "radix-ui";
import { cn } from "@/lib/utils";
import type { CardBadge } from "./filter-model";

// §8 mentions of paid options on a card: "À la Une · Sponsorisé" (served in a sponsored slot) and
// "Remontée" (position bought with a bump), each with its info-bubble text. A tap, a click or Enter
// opens the bubble (a hover-only tooltip would leave touch screens without it); screen readers get
// the same text as the description of the badge. Above the stretched card link (relative z-10).

export function BoostBadge({ kind, className }: { kind: CardBadge; className?: string }) {
  const t = useTranslations("ListingCard");
  const id = useId();
  const label = kind === "featured" ? t("featured") : t("bumped");
  const info = kind === "featured" ? t("featuredInfo") : t("bumpedInfo");
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-badge={kind}
          aria-describedby={`${id}-info`}
          className={cn(
            "relative z-10 inline-flex max-w-full items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium",
            // 44 px touch target around a small label.
            "after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']",
            kind === "featured" ? "bg-featured text-featured-foreground" : "border border-featured/70 bg-gold-100/60 text-foreground dark:bg-transparent",
            className,
          )}
        >
          {kind === "bumped" ? <ArrowUp className="size-3 shrink-0" aria-hidden="true" /> : null}
          <span className="truncate">{label}</span>
        </button>
      </Popover.Trigger>
      <span id={`${id}-info`} hidden>
        {info}
      </span>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="z-50 max-w-64 rounded-md border border-border bg-surface px-3 py-2.5 text-sm text-foreground shadow-lg shadow-bab-950/15 text-pretty data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {info}
          <Popover.Arrow className="fill-surface" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
