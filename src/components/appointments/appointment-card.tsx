"use client";

import { useId, useState } from "react";
import { CalendarCheck, CalendarClock, CalendarPlus, CalendarX, Car, Handshake, House, MapPin, Package, ShieldCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { SITE_NAME, type Locale } from "@/config/site";
import { APPOINTMENT_CANCEL_REASONS, type AppointmentAction, type AppointmentCancelReason, type AppointmentKind, type AppointmentResponse, type AppointmentView, type Slot } from "@/lib/contracts/appointments";
import { URL_MARKER } from "@/lib/contracts/messaging";
import { postAppointmentAction } from "@/lib/appointments/client";
import { appointmentIcs, downloadIcs } from "@/lib/appointments/ics";
import { isActive } from "@/lib/appointments/rules";
import { moroccoClock } from "@/lib/appointments/time";
import { isolate } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import { useAppointmentErrorMessage } from "./errors";
import { dayTile, formatSlotDay, formatSlotRange } from "./format";

// The conversation's current appointment, pinned under the thread header while it is active
// (architecture §5, 28 Oct). For the one who answers: the proposed slots to pick from, confirm or
// "none suits me". For the proposer: the slots sent, withdraw or change them. Once confirmed: the
// date as a small door, the place, add to my calendar (.ics), reschedule or cancel with a reason.
// Ended appointments live on in the thread's system messages only.

export const KIND_ICONS: Record<AppointmentKind, typeof Handshake> = { meeting: Handshake, visit: House, test_drive: Car, pickup: Package };

/** The date of a slot as a door-shaped tile (the brand's arch). */
export function DateDoor({ slot, locale, className }: { slot: Slot; locale: Locale; className?: string }) {
  const tile = dayTile(moroccoClock(slot.start).day, locale);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex w-14 shrink-0 flex-col items-center rounded-t-full rounded-b-md bg-structure pt-3 pb-1.5 text-structure-foreground shadow-sm ring-2 ring-gold-300/60 ring-offset-2 ring-offset-surface",
        className,
      )}
    >
      <span className="text-[0.625rem] leading-3 text-structure-foreground/80">{tile.weekday}</span>
      <span className="text-xl leading-7 font-semibold tabular-nums">{tile.date}</span>
      <span className="text-[0.625rem] leading-3 text-structure-foreground/80">{tile.month}</span>
    </span>
  );
}

/** Cancel reasons offered to a participant: only the seller can say the item is gone. */
export const cancelReasonsFor = (role: "buyer" | "seller"): AppointmentCancelReason[] =>
  APPOINTMENT_CANCEL_REASONS.filter((reason) => reason !== "sold" || role === "seller");

/** The place with its masked links shown as such. */
export const placeText = (place: string, masked: string) => place.split(URL_MARKER).join(masked);

export interface AppointmentCardProps {
  cid: string;
  appointment: AppointmentView;
  /** My side of the conversation. */
  role: "buyer" | "seller";
  counterpartName: string;
  listingTitle: string;
  /** False when the conversation is read-only (blocked, frozen, closed, suspended): no action. */
  writable: boolean;
  onChange: (response: AppointmentResponse) => void;
  /** Opens the slot picker to propose other slots. */
  onReschedule: () => void;
  /** The thread's clock (refreshed every 15 s). */
  now: number;
}

export function AppointmentCard({ cid, appointment, role, counterpartName, listingTitle, writable, onChange, onReschedule, now }: AppointmentCardProps) {
  const t = useTranslations("Appointments.card");
  const kindLabel = useTranslations("Appointments.kind");
  const kindPhrase = useTranslations("Appointments.kindPhrase");
  const confirmedTitle = useTranslations("Appointments.confirmedTitle");
  const reasons = useTranslations("Appointments.reasons");
  const locale = useLocale() as Locale;
  const id = useId();
  const errorMessage = useAppointmentErrorMessage();
  const [busy, setBusy] = useState<AppointmentAction["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<number | null>(appointment.slots.length === 1 ? (appointment.slots[0]?.start ?? null) : null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState<AppointmentCancelReason | null>(null);

  if (!isActive(appointment, now)) return null;
  const name = isolate(counterpartName);
  const Icon = KIND_ICONS[appointment.kind] ?? Handshake;
  const place = appointment.place ? placeText(appointment.place, t("maskedLink")) : null;

  async function act(action: AppointmentAction, done: string) {
    setBusy(action.action);
    setError(null);
    try {
      const response = await postAppointmentAction(cid, action);
      onChange(response);
      toast.success(done);
      setCancelling(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  function addToCalendar(slot: Slot) {
    const title = t("icsTitle", { kind: kindLabel(appointment.kind), name: counterpartName, site: SITE_NAME });
    const url = `${window.location.origin}${window.location.pathname}`;
    downloadIcs(appointmentIcs({ id: appointment.id, slot, title, description: `${listingTitle}\n${url}`, place, url }), `${SITE_NAME.toLowerCase()}-${appointment.kind}`);
  }

  const placeLine = place ? (
    <p dir="auto" className="flex items-center gap-1.5 text-sm text-foreground-muted">
      <MapPin className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{place}</span>
    </p>
  ) : null;

  const safety = (
    <p className="flex gap-1.5 text-xs text-foreground-muted text-pretty">
      <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" aria-hidden="true" />
      {t("safety", { site: SITE_NAME })}
    </p>
  );

  const frame = "mx-3 mt-3 flex flex-col gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-sm lg:mx-5";

  if (appointment.status === "confirmed" && appointment.chosen) {
    const slot = appointment.chosen;
    return (
      <section aria-labelledby={`${id}-title`} className={cn(frame, "border-structure/25")} data-testid="appointment-card" data-status="confirmed">
        <div className="flex items-center gap-3.5">
          <DateDoor slot={slot} locale={locale} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 id={`${id}-title`} className="flex items-center gap-1.5 font-semibold">
              <CalendarCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
              {confirmedTitle(appointment.kind)}
            </h3>
            <p className="text-sm">
              <span className="inline-block first-letter:uppercase">{formatSlotDay(slot.start, locale)}</span>
              <span className="ms-1.5 font-medium tabular-nums">{formatSlotRange(slot, locale)}</span>
            </p>
            {placeLine}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={() => addToCalendar(slot)}>
            <CalendarPlus aria-hidden="true" />
            {t("addToCalendar")}
          </Button>
          {writable ? (
            <>
              <Button type="button" variant="ghost" size="sm" className="max-sm:h-11" onClick={onReschedule}>
                <CalendarClock aria-hidden="true" />
                {t("reschedule")}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="text-danger max-sm:h-11" onClick={() => setCancelling(true)}>
                <CalendarX aria-hidden="true" />
                {t("cancel")}
              </Button>
            </>
          ) : null}
        </div>
        {safety}
        {error && !cancelling ? <InlineError>{error}</InlineError> : null}
        <Dialog.Root open={cancelling} onOpenChange={setCancelling}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
            <Dialog.Content
              className={cn(
                "fixed inset-x-4 bottom-4 z-50 flex flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-xl shadow-bab-950/20 outline-none",
                "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 rtl:sm:translate-x-1/2",
                "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
              )}
            >
              <Dialog.Title className="text-lg font-semibold text-balance">{t("cancelTitle")}</Dialog.Title>
              <Dialog.Description className="text-foreground-muted text-pretty">{t("cancelBody", { name })}</Dialog.Description>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{t("reason")}</legend>
                {cancelReasonsFor(role).map((item) => (
                  <label key={item} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 has-[:checked]:border-structure has-[:checked]:bg-structure/5">
                    <input type="radio" name={`${id}-reason`} value={item} checked={reason === item} onChange={() => setReason(item)} className="size-4 accent-[var(--color-structure)]" />
                    <span className="text-sm">{reasons(item)}</span>
                  </label>
                ))}
              </fieldset>
              {error ? <InlineError>{error}</InlineError> : null}
              <div className="mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline">
                    {t("keep")}
                  </Button>
                </Dialog.Close>
                <Button
                  type="button"
                  variant="danger"
                  loading={busy === "cancel"}
                  onClick={() => void act({ action: "cancel", id: appointment.id, ...(reason ? { reason } : {}) }, t("cancelledToast"))}
                >
                  {t("cancelConfirm")}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </section>
    );
  }

  const open = appointment.slots.filter((slot) => slot.start > now);

  if (appointment.proposedByMe) {
    return (
      <section aria-labelledby={`${id}-title`} className={frame} data-testid="appointment-card" data-status="proposed-mine">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-t-full rounded-b-sm bg-primary/12 text-primary">
            <Icon className="size-4.5" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 id={`${id}-title`} className="font-semibold text-pretty">
              {t("proposedMine", { count: appointment.slots.length, name, kind: kindPhrase(appointment.kind) })}
            </h3>
            <p className="text-sm text-foreground-muted">{t("waiting", { name })}</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {open.map((slot) => (
                <li key={slot.start} className="rounded-full bg-surface-muted px-2.5 py-1 text-xs tabular-nums">
                  <span className="inline-block first-letter:uppercase">{formatSlotDay(slot.start, locale)}</span>
                  <span className="ms-1.5 text-foreground-muted">{formatSlotRange(slot, locale)}</span>
                </li>
              ))}
            </ul>
            {placeLine}
          </div>
        </div>
        {writable ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={onReschedule}>
              <CalendarClock aria-hidden="true" />
              {t("change")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="max-sm:h-11" loading={busy === "withdraw"} onClick={() => void act({ action: "withdraw", id: appointment.id }, t("withdrawnToast"))}>
              {t("withdraw")}
            </Button>
          </div>
        ) : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className={cn(frame, "border-primary/40 ring-1 ring-primary/15")} data-testid="appointment-card" data-status="proposed-theirs">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-t-full rounded-b-sm bg-primary text-primary-foreground">
          <Icon className="size-4.5" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 id={`${id}-title`} className="font-semibold text-pretty">
            {t("proposedTheirs", { count: appointment.slots.length, name, kind: kindPhrase(appointment.kind) })}
          </h3>
          {placeLine}
        </div>
      </div>
      <fieldset disabled={!writable} className="flex flex-col gap-1.5">
        <legend className="sr-only">{t("pick")}</legend>
        {open.map((slot) => (
          <label
            key={slot.start}
            data-testid="appointment-slot"
            className={cn(
              "flex min-h-12 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition-colors duration-150 ease-door",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
              choice === slot.start ? "border-primary bg-primary/8" : "border-border hover:bg-surface-muted",
            )}
          >
            <input type="radio" name={`${id}-slot`} value={slot.start} checked={choice === slot.start} onChange={() => setChoice(slot.start)} className="size-4 accent-[var(--color-primary)]" />
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
              <span className="inline-block text-sm font-medium first-letter:uppercase">{formatSlotDay(slot.start, locale)}</span>
              <span className="text-sm text-foreground-muted tabular-nums">{formatSlotRange(slot, locale)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {writable ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            type="button"
            className="max-sm:w-full"
            disabled={choice === null}
            loading={busy === "confirm"}
            onClick={() => choice !== null && void act({ action: "confirm", id: appointment.id, start: choice }, t("confirmedToast"))}
            data-testid="appointment-confirm"
          >
            <CalendarCheck aria-hidden="true" />
            {t("confirm")}
          </Button>
          <Button type="button" variant="outline" className="max-sm:w-full" onClick={onReschedule}>
            {t("counter")}
          </Button>
          <Button type="button" variant="ghost" className="max-sm:w-full" loading={busy === "decline"} onClick={() => void act({ action: "decline", id: appointment.id }, t("declinedToast"))}>
            {t("decline")}
          </Button>
        </div>
      ) : null}
      {safety}
      {error ? <InlineError>{error}</InlineError> : null}
    </section>
  );
}
