"use client";

import { BedDouble, CalendarCheck, CalendarSearch, CalendarX, CarFront, Undo2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/config/site";
import type { RentalRequestEvent, RentalRequestEventView } from "@/lib/contracts/rental-requests";
import { URL_MARKER } from "@/lib/contracts/messaging";
import { ReportButton } from "@/components/messages/report-button";
import { isolate } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import { formatRentalDay } from "./rental-day";

// A booking request step in the thread (system message): who asked or answered, for which days,
// in Morocco's calendar; a holiday home's stay with its own wording (RentalRequest.event.home). A
// received request with a pick-up place can be reported like a message (A-02).

const ICONS: Record<RentalRequestEvent, typeof CarFront> = { requested: CarFront, changed: CalendarSearch, accepted: CalendarCheck, declined: CalendarX, withdrawn: Undo2 };

export function RentalRequestEventItem({ step, counterpartName, time, onReport }: { step: RentalRequestEventView; counterpartName: string; time: string; onReport?: () => void }) {
  const t = useTranslations("RentalRequest.event");
  const card = useTranslations("RentalRequest.card");
  const thread = useTranslations("Messaging.thread");
  const locale = useLocale() as Locale;
  const stay = step.unit === "night";
  const Icon = stay && step.event === "requested" ? BedDouble : ICONS[step.event];
  const period = t("period", { from: formatRentalDay(step.from, locale), to: formatRentalDay(step.to, locale) });
  const tone = step.event === "accepted" ? "text-success" : step.event === "declined" ? "text-danger" : "text-primary";
  const pickup = step.pickup && (step.event === "requested" || step.event === "changed") ? step.pickup.split(URL_MARKER).join(card("maskedLink")) : null;
  return (
    <li className="group/message flex items-center justify-center gap-1 py-1" data-testid="rental-request-event" data-event={step.event}>
      <p dir="auto" className="flex max-w-[90%] items-start gap-2 rounded-2xl border border-border bg-surface px-3.5 py-2 text-sm text-pretty shadow-xs">
        <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden="true" />
        <span className="min-w-0">
          <span className="sr-only">{thread("system")} : </span>
          {stay && (step.event === "requested" || step.event === "declined")
            ? t(`home.${step.event}.${step.byMe ? "mine" : "theirs"}`, { name: isolate(counterpartName), period })
            : t(`${step.event}.${step.byMe ? "mine" : "theirs"}`, { name: isolate(counterpartName), period })}
          {pickup ? <span className="text-foreground-muted"> ({t(stay ? "home.pickup" : "pickup", { place: isolate(pickup) })})</span> : null}
          <time className="ms-2 text-[0.6875rem] text-foreground-muted tabular-nums">{time}</time>
        </span>
      </p>
      {onReport ? <ReportButton onClick={onReport} /> : null}
    </li>
  );
}
