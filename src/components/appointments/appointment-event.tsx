"use client";

import { BellRing, CalendarCheck, CalendarClock, CalendarPlus, CalendarX, Undo2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/config/site";
import type { AppointmentEvent, AppointmentEventView } from "@/lib/contracts/appointments";
import { ReportButton } from "@/components/messages/report-button";
import { isolate } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import { formatSlotClock, formatSlotDay, placeText } from "./format";

// An appointment step in the thread (system message): who did what, the proposer's place on a
// proposal, and for a confirmation, a cancellation or a reminder, the slot in Morocco's time. A
// received proposal with a place can be reported like a message (A-02).

const ICONS: Record<AppointmentEvent, typeof CalendarPlus> = {
  proposed: CalendarPlus,
  rescheduled: CalendarClock,
  confirmed: CalendarCheck,
  declined: CalendarX,
  withdrawn: Undo2,
  cancelled: CalendarX,
  reminder: BellRing,
};

export function AppointmentEventItem({ step, counterpartName, time, onReport }: { step: AppointmentEventView; counterpartName: string; time: string; onReport?: () => void }) {
  const t = useTranslations("Appointments.event");
  const card = useTranslations("Appointments.card");
  const kindPhrase = useTranslations("Appointments.kindPhrase");
  const reasons = useTranslations("Appointments.reasons");
  const thread = useTranslations("Messaging.thread");
  const locale = useLocale() as Locale;
  const Icon = ICONS[step.event];
  const when = step.slot ? t("when", { day: formatSlotDay(step.slot.start, locale), time: formatSlotClock(step.slot.start, locale) }) : "";
  const values = { name: isolate(counterpartName), kind: kindPhrase(step.kind), when };
  const key = step.event === "reminder" ? "reminder" : (`${step.event}.${step.byMe ? "mine" : "theirs"}` as const);
  const place = step.place && (step.event === "proposed" || step.event === "rescheduled") ? placeText(step.place, card("maskedLink")) : null;
  const tone = step.event === "confirmed" ? "text-success" : step.event === "cancelled" || step.event === "declined" ? "text-danger" : step.event === "reminder" ? "text-gold-700 dark:text-gold-300" : "text-primary";
  return (
    <li className="group/message flex items-center justify-center gap-1 py-1" data-testid="appointment-event" data-event={step.event}>
      <p dir="auto" className="flex max-w-[90%] items-start gap-2 rounded-2xl border border-border bg-surface px-3.5 py-2 text-sm text-pretty shadow-xs">
        <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden="true" />
        <span className="min-w-0">
          <span className="sr-only">{thread("system")} : </span>
          {t(key, values)}
          {step.event === "cancelled" && step.reason ? <span className="text-foreground-muted"> ({reasons(step.reason)})</span> : null}
          {place ? <span className="text-foreground-muted"> ({t("place", { place: isolate(place) })})</span> : null}
          <time className="ms-2 text-[0.6875rem] text-foreground-muted tabular-nums">{time}</time>
        </span>
      </p>
      {onReport ? <ReportButton onClick={onReport} /> : null}
    </li>
  );
}
