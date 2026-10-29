"use client";

import { BadgeCheck, HandCoins, Hourglass, Reply, Undo2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/config/site";
import type { OfferEvent, OfferEventView } from "@/lib/contracts/offers";
import { isolate } from "@/lib/i18n/bidi";
import { formatPrice } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// A price offer step in the thread (system message, Carte vivante lot 5): who offered, countered,
// accepted, declined or withdrew, and the amount.

const ICONS: Record<OfferEvent, typeof HandCoins> = { made: HandCoins, countered: Reply, accepted: BadgeCheck, declined: X, withdrawn: Undo2, expired: Hourglass };

export function OfferEventItem({ step, counterpartName, time }: { step: OfferEventView; counterpartName: string; time: string }) {
  const t = useTranslations("Offers.event");
  const thread = useTranslations("Messaging.thread");
  const locale = useLocale() as Locale;
  const Icon = ICONS[step.event];
  const tone = step.event === "accepted" ? "text-success" : step.event === "declined" ? "text-danger" : step.event === "expired" || step.event === "withdrawn" ? "text-foreground-muted" : "text-primary";
  const values = { name: isolate(counterpartName), amount: formatPrice(step.amount, locale) };
  return (
    <li className="flex justify-center py-1" data-testid="offer-event" data-event={step.event}>
      <p dir="auto" className="flex max-w-[90%] items-start gap-2 rounded-2xl border border-border bg-surface px-3.5 py-2 text-sm text-pretty shadow-xs">
        <Icon className={cn("mt-0.5 size-4 shrink-0", step.event === "countered" && "rtl:-scale-x-100", tone)} aria-hidden="true" />
        <span className="min-w-0">
          <span className="sr-only">{thread("system")} : </span>
          {step.event === "expired" ? t("expired", values) : t(`${step.event}.${step.byMe ? "mine" : "theirs"}`, values)}
          <time className="ms-2 text-[0.6875rem] text-foreground-muted tabular-nums">{time}</time>
        </span>
      </p>
    </li>
  );
}
