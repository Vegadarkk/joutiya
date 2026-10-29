"use client";

import { useCallback, useId, useState } from "react";
import { BedDouble, CalendarCheck, CalendarRange, CalendarX, CarFront, MapPin, NotebookPen, Package, ShieldCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { InlineError } from "@/components/feedback/inline-error";
import { useMessagingErrorMessage } from "@/components/messages/errors";
import { Button } from "@/components/ui/button";
import { SITE_NAME, type Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/auth/client";
import { URL_MARKER } from "@/lib/contracts/messaging";
import { rentalRequestOpen, type RentalRequestAction, type RentalRequestResponse, type RentalRequestView } from "@/lib/contracts/rental-requests";
import { isolate } from "@/lib/i18n/bidi";
import { moroccoToday, rentalDuration } from "@/lib/listings/rental-availability";
import { postRentalRequestAction } from "@/lib/rental-requests/client";
import { cn } from "@/lib/utils";
import { formatRentalDay } from "./rental-day";

// The conversation's current booking request of a car rental, pinned under the thread header while
// it is open (rental pack §6); a holiday home's stay reads by nights, with the guest's note, and has
// no pick-up appointment (seasonal rental conception §3). For the agency: the renter's days and pick-up place, "Disponible"
// (optionally blocking the days on the listing) or "Pas disponible". For the renter: the request
// sent, withdraw it. Once accepted: the days, and the pick-up appointment of the messaging. The
// card always says that nothing is paid through the site.

const ERROR_KEYS = ["rental_request_changed", "rental_request_past", "rental_request_unavailable", "place_payment_details"] as const;

/** Texts of a stay (RentalRequest.card.home), the car rental's otherwise. */
type HomeKey = "period" | "pickup" | "waiting" | "requestedTheirs" | "block" | "blockHint" | "blockFailed" | "planning" | "blockedNote" | "safety";
export const rentalCardKey = <K extends HomeKey>(key: K, unit: RentalRequestView["unit"]) => (unit === "night" ? (`home.${key}` as const) : key);

export function useRentalRequestErrorMessage(): (error: unknown) => string {
  const t = useTranslations("RentalRequest.errors");
  const messaging = useMessagingErrorMessage();
  return useCallback(
    (error: unknown) => {
      const code = error instanceof ApiError ? error.code : null;
      const key = ERROR_KEYS.find((item) => item === code);
      return key ? t(key) : messaging(error);
    },
    [t, messaging],
  );
}

export interface RentalRequestCardProps {
  cid: string;
  request: RentalRequestView;
  counterpartName: string;
  /** False when the conversation is read-only (blocked, frozen, closed, suspended): no action. */
  writable: boolean;
  /** The thread's clock (refreshed every 15 s). */
  now: number;
  onChange: (response: RentalRequestResponse) => void;
  /** Opens the slot picker on a pick-up appointment; absent while an appointment is active. */
  onPickup?: () => void;
}

export function RentalRequestCard({ cid, request, counterpartName, writable, now, onChange, onPickup }: RentalRequestCardProps) {
  const t = useTranslations("RentalRequest.card");
  const locale = useLocale() as Locale;
  const id = useId();
  const errorMessage = useRentalRequestErrorMessage();
  const [busy, setBusy] = useState<RentalRequestAction["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [block, setBlock] = useState(true);
  const [blockFailed, setBlockFailed] = useState(false);

  if (!rentalRequestOpen(request, moroccoToday(now))) return null;
  const name = isolate(counterpartName);
  const agency = !request.requestedByMe;
  const stay = request.unit === "night";
  const k = <K extends HomeKey>(key: K) => rentalCardKey(key, request.unit);

  async function act(action: RentalRequestAction, done: string) {
    setBusy(action.action);
    setError(null);
    try {
      const response = await postRentalRequestAction(cid, action);
      setBlockFailed(response.blocked === false);
      onChange(response);
      toast.success(done);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  const period = (
    <p className="flex items-center gap-1.5 text-sm font-medium">
      <CalendarRange className="size-4 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
      <span className="tabular-nums">{t(k("period"), { from: formatRentalDay(request.from, locale), to: formatRentalDay(request.to, locale), days: rentalDuration(request) })}</span>
    </p>
  );
  const PickupIcon = stay ? NotebookPen : MapPin;
  const pickup = request.pickup ? (
    <p dir="auto" className="flex items-center gap-1.5 text-sm text-foreground-muted">
      <PickupIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{t(k("pickup"), { place: isolate(request.pickup.split(URL_MARKER).join(t("maskedLink"))) })}</span>
    </p>
  ) : null;
  const safety = (
    <p className="flex gap-1.5 text-xs text-foreground-muted text-pretty">
      <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" aria-hidden="true" />
      {t(k("safety"), { site: SITE_NAME })}
    </p>
  );
  const frame = "mx-3 mt-3 flex flex-col gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-sm lg:mx-5";
  const badge = (accepted: boolean) => (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-t-full rounded-b-sm",
        accepted ? "bg-success-surface text-success" : agency ? "bg-primary text-primary-foreground" : "bg-primary/12 text-primary",
      )}
    >
      {accepted ? <CalendarCheck className="size-4.5" /> : stay ? <BedDouble className="size-4.5" /> : <CarFront className="size-4.5" />}
    </span>
  );

  if (request.status === "accepted") {
    return (
      <section aria-labelledby={`${id}-title`} className={cn(frame, "border-structure/25")} data-testid="rental-request-card" data-status="accepted">
        <div className="flex items-start gap-3">
          {badge(true)}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 id={`${id}-title`} className="font-semibold text-pretty">
              {agency ? t("acceptedMine") : t("acceptedTheirs", { name })}
            </h3>
            {period}
            {pickup}
            {request.blocked ? <p className="text-xs text-foreground-muted">{t(k("blockedNote"))}</p> : null}
          </div>
        </div>
        {blockFailed ? (
          <div className="flex flex-col items-start gap-2">
            <InlineError>{t(k("blockFailed"))}</InlineError>
            <Button asChild variant="outline" size="sm" className="max-sm:h-11">
              <Link href={stay ? "/mes-annonces" : "/pro/flotte"}>{t(k("planning"))}</Link>
            </Button>
          </div>
        ) : null}
        {writable && onPickup && !stay ? (
          <Button type="button" variant="outline" size="sm" className="self-start max-sm:h-11" onClick={onPickup} data-testid="rental-request-pickup">
            <Package aria-hidden="true" />
            {t("pickupAppointment")}
          </Button>
        ) : null}
        {safety}
      </section>
    );
  }

  if (!agency) {
    return (
      <section aria-labelledby={`${id}-title`} className={frame} data-testid="rental-request-card" data-status="requested-mine">
        <div className="flex items-start gap-3">
          {badge(false)}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 id={`${id}-title`} className="font-semibold text-pretty">
              {t("requestedMine", { name })}
            </h3>
            {period}
            {pickup}
            <p className="text-sm text-foreground-muted">{t(k("waiting"))}</p>
          </div>
        </div>
        {writable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start max-sm:h-11"
            loading={busy === "withdraw"}
            onClick={() => void act({ action: "withdraw", id: request.id }, t("withdrawnToast"))}
          >
            {t("withdraw")}
          </Button>
        ) : null}
        {safety}
        {error ? <InlineError>{error}</InlineError> : null}
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className={cn(frame, "border-primary/40 ring-1 ring-primary/15")} data-testid="rental-request-card" data-status="requested-theirs">
      <div className="flex items-start gap-3">
        {badge(false)}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 id={`${id}-title`} className="font-semibold text-pretty">
            {t(k("requestedTheirs"), { name })}
          </h3>
          {period}
          {pickup}
        </div>
      </div>
      {writable ? (
        <>
          <label htmlFor={`${id}-block`} className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 has-[:checked]:border-structure has-[:checked]:bg-structure/5">
            <input
              id={`${id}-block`}
              type="checkbox"
              checked={block}
              onChange={(event) => setBlock(event.target.checked)}
              aria-describedby={`${id}-block-hint`}
              data-testid="rental-request-block"
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-structure)]"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{t(k("block"))}</span>
              <span id={`${id}-block-hint`} className="text-xs text-foreground-muted text-pretty">
                {t(k("blockHint"))}
              </span>
            </span>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              className="max-sm:w-full"
              loading={busy === "accept"}
              disabled={busy !== null && busy !== "accept"}
              onClick={() => void act({ action: "accept", id: request.id, block }, t("acceptedToast"))}
              data-testid="rental-request-accept"
            >
              <CalendarCheck aria-hidden="true" />
              {t("accept")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="max-sm:w-full"
              loading={busy === "decline"}
              disabled={busy !== null && busy !== "decline"}
              onClick={() => void act({ action: "decline", id: request.id }, t("declinedToast"))}
              data-testid="rental-request-decline"
            >
              <CalendarX aria-hidden="true" />
              {t("decline")}
            </Button>
          </div>
        </>
      ) : null}
      {safety}
      {error ? <InlineError>{error}</InlineError> : null}
    </section>
  );
}
