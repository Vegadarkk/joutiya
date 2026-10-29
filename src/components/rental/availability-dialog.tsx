"use client";

import { useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import { isApiError } from "@/lib/auth/client";
import type { RentalAvailability } from "@/lib/contracts/listings";
import { isolate } from "@/lib/i18n/bidi";
import { saveAvailability } from "@/lib/listings/client/api";
import { formatDate } from "@/lib/listings/client/format";
import { RENTAL_AHEAD_DAYS, RENTAL_PERIODS_MAX, blockedSet, isFresh, moroccoToday, periodsOf } from "@/lib/listings/rental-availability";
import { cn } from "@/lib/utils";
import { AvailabilityCalendar } from "./availability-calendar";

// The agency's calendar of one car rental (rental pack §3): tap the first then the last day of a
// period to block it (or free it when it starts on a blocked day); save, or confirm unchanged days
// are up to date. Two months shown, up to the 365-day horizon.

interface AvailabilityDialogProps {
  listingId: string;
  title: string;
  rental: RentalAvailability;
  onClose: () => void;
  onSaved: (rental: RentalAvailability) => void;
  /** Tests: the clock. */
  now?: number;
}

const MONTHS_SHOWN = 2;

export function AvailabilityDialog({ listingId, title, rental, onClose, onSaved, now }: AvailabilityDialogProps) {
  const t = useTranslations("Rental.availability");
  const locale = useLocale() as Locale;
  const apiMessage = useApiErrorMessage();
  const descriptionId = useId();
  const [clock] = useState(() => now ?? Date.now());
  const today = moroccoToday(clock);
  const lastDay = today + RENTAL_AHEAD_DAYS - 1;
  const initial = useMemo(() => [...blockedSet(rental.unavailable)].filter((day) => day >= today), [rental.unavailable, today]);
  const [blocked, setBlocked] = useState<Set<number>>(() => new Set(initial));
  const [anchor, setAnchor] = useState<number | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);
  const [saving, setSaving] = useState(false);
  const periods = periodsOf(blocked);
  const changed = blocked.size !== initial.length || initial.some((day) => !blocked.has(day));
  const tooMany = periods.length > RENTAL_PERIODS_MAX;
  const fresh = isFresh(rental.updatedAt ? Date.parse(rental.updatedAt) : null, clock);

  function onDay(day: number) {
    if (anchor === null) {
      setAnchor(day);
      return;
    }
    const [from, to] = anchor <= day ? [anchor, day] : [day, anchor];
    // The period takes the opposite of its first day's state: a free start blocks, a blocked one frees.
    const block = !blocked.has(anchor);
    setBlocked((current) => {
      const next = new Set(current);
      for (let each = from; each <= to; each += 1) {
        if (block) next.add(each);
        else next.delete(each);
      }
      return next;
    });
    setAnchor(null);
  }

  async function save() {
    setSaving(true);
    try {
      const response = await saveAvailability(listingId, { unavailable: periods, since: rental.updatedAt });
      toast.success(t(changed ? "saved" : "confirmed"));
      onSaved(response.rental);
      onClose();
    } catch (error) {
      toast.error(isApiError(error, "conflict") ? t("conflict") : apiMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(value) => !value && !saving && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={descriptionId}
          data-testid="availability-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[88dvh] sm:w-full sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex flex-col gap-1.5 border-b border-border px-5 pt-5 pb-4 sm:px-6">
            <Dialog.Title className="text-lg font-semibold text-balance">{t("title", { title: isolate(title) })}</Dialog.Title>
            <Dialog.Description id={descriptionId} className="text-sm text-foreground-muted text-pretty">
              {t("hint")}
            </Dialog.Description>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5 sm:px-6">
            <p className={cn("text-sm", fresh ? "text-foreground-muted" : "font-medium text-warning")} data-testid="availability-freshness">
              {rental.updatedAt ? (fresh ? t("updatedOn", { date: formatDate(new Date(rental.updatedAt), locale) }) : t("stale", { date: formatDate(new Date(rental.updatedAt), locale) })) : t("never")}
            </p>
            <AvailabilityCalendar
              locale={locale}
              today={today}
              lastDay={lastDay}
              blocked={blocked}
              monthOffset={monthOffset}
              months={MONTHS_SHOWN}
              onDay={onDay}
              anchor={anchor}
              onMonthOffset={(offset) => setMonthOffset(offset)}
              maxMonthOffset={12 - MONTHS_SHOWN}
            />
            <p role="status" className="min-h-5 text-sm text-foreground-muted">
              {anchor !== null ? t("anchor") : tooMany ? <span className="text-danger">{t("tooMany", { max: RENTAL_PERIODS_MAX })}</span> : periods.length ? t("summary", { count: periods.length }) : t("summaryNone")}
            </p>
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
            <Dialog.Close asChild>
              <Button type="button" variant="outline" disabled={saving}>
                {t("cancel")}
              </Button>
            </Dialog.Close>
            <Button type="button" loading={saving} disabled={tooMany || anchor !== null} onClick={() => void save()}>
              {changed ? t("save") : t("confirm")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
