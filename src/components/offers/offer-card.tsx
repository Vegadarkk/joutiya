"use client";

import { useId, useState } from "react";
import { BadgeCheck, HandCoins, Hourglass, Reply, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import { offerFinalAmount, type OfferAction, type OfferResponse, type OfferView } from "@/lib/contracts/offers";
import { isolate } from "@/lib/i18n/bidi";
import { formatPrice } from "@/lib/listings/client/format";
import { postOfferAction } from "@/lib/offers/client";
import { cn } from "@/lib/utils";
import { OfferNotice } from "./offer-notice";
import { useOfferErrorMessage } from "./errors";

// The conversation's current price offer, pinned under the thread header (Carte vivante lot 5)
// while it waits for an answer, and for a week once accepted. Buyer: his offer and "Retirer", or
// the seller's counter-offer to accept. Seller: the offer against the listed price, "Accepter",
// "Contre-offre" (the dialog), "Refuser". Declined, withdrawn and expired offers live on as steps
// of the thread only. The card always says that an accepted offer is no sale and no payment.

const HOUR_MS = 60 * 60 * 1000;
/** An accepted offer stays pinned this long. */
const ACCEPTED_PINNED_MS = 7 * 24 * HOUR_MS;

/** Whether the card shows at `now`. */
export function offerCardShown(offer: Pick<OfferView, "status" | "updatedAt">, now: number): boolean {
  if (offer.status === "open" || offer.status === "countered") return true;
  return offer.status === "accepted" && now - offer.updatedAt < ACCEPTED_PINNED_MS;
}

export interface OfferCardProps {
  cid: string;
  offer: OfferView;
  counterpartName: string;
  /** False when the conversation is read-only (blocked, frozen, closed, suspended): no action. */
  writable: boolean;
  /** The thread's clock (refreshed every 15 s). */
  now: number;
  onChange: (response: OfferResponse) => void;
  /** Opens the counter-offer dialog (seller, open offer). */
  onCounter: () => void;
}

export function OfferCard({ cid, offer, counterpartName, writable, now, onChange, onCounter }: OfferCardProps) {
  const t = useTranslations("Offers.card");
  const locale = useLocale() as Locale;
  const id = useId();
  const errorMessage = useOfferErrorMessage();
  const [busy, setBusy] = useState<OfferAction["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!offerCardShown(offer, now)) return null;
  const name = isolate(counterpartName);
  const buyer = offer.madeByMe;
  const price = (amount: number) => formatPrice(amount, locale);
  const hoursLeft = Math.ceil((offer.expiresAt - now) / HOUR_MS);

  async function act(action: OfferAction, done: string) {
    setBusy(action.action);
    setError(null);
    try {
      onChange(await postOfferAction(cid, action));
      toast.success(done);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  const frame = "mx-3 mt-3 flex flex-col gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-sm lg:mx-5";
  const accepted = offer.status === "accepted";
  // The one who must answer now: the seller on an open offer, the buyer on a counter-offer.
  const myTurn = (offer.status === "open" && !buyer) || (offer.status === "countered" && buyer);
  const badge = (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-t-full rounded-b-sm",
        accepted ? "bg-success-surface text-success" : myTurn ? "bg-primary text-primary-foreground" : "bg-primary/12 text-primary",
      )}
    >
      {accepted ? <BadgeCheck className="size-5" /> : <HandCoins className="size-5" />}
    </span>
  );
  const expiry =
    accepted || hoursLeft <= 0 ? null : (
      <p className="flex items-center gap-1.5 text-xs text-foreground-muted tabular-nums">
        <Hourglass className="size-3.5 shrink-0" aria-hidden="true" />
        {hoursLeft <= 1 ? t("expiresSoon") : t("expiresIn", { hours: hoursLeft })}
      </p>
    );

  let title: string;
  let detail: string | null = null;
  if (accepted) {
    title = t("acceptedTitle", { amount: price(offerFinalAmount(offer)) });
    detail = t("listed", { price: price(offer.price) });
  } else if (offer.status === "open") {
    title = buyer ? t("pendingMine", { amount: price(offer.amount) }) : t("received", { name, amount: price(offer.amount) });
    detail = buyer ? t("waiting", { name }) : t("listed", { price: price(offer.price) });
  } else {
    title = buyer ? t("counterReceived", { name, amount: price(offer.counter ?? offer.amount) }) : t("counterMine", { amount: price(offer.counter ?? offer.amount) });
    detail = buyer ? t("yourOffer", { amount: price(offer.amount) }) : t("waiting", { name });
  }

  const actions = !writable || accepted ? null : !buyer && offer.status === "open" ? (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <Button
        type="button"
        className="max-sm:w-full"
        loading={busy === "accept"}
        disabled={busy !== null && busy !== "accept"}
        onClick={() => void act({ action: "accept", id: offer.id }, t("acceptedToast"))}
        data-testid="offer-accept"
      >
        <BadgeCheck aria-hidden="true" />
        {t("acceptAmount", { amount: price(offer.amount) })}
      </Button>
      <Button type="button" variant="structure" className="max-sm:w-full" disabled={busy !== null} onClick={onCounter} aria-haspopup="dialog" data-testid="offer-counter">
        <Reply className="rtl:-scale-x-100" aria-hidden="true" />
        {t("counter")}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="max-sm:w-full"
        loading={busy === "decline"}
        disabled={busy !== null && busy !== "decline"}
        onClick={() => void act({ action: "decline", id: offer.id }, t("declinedToast"))}
        data-testid="offer-decline"
      >
        <X aria-hidden="true" />
        {t("decline")}
      </Button>
    </div>
  ) : buyer ? (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {offer.status === "countered" ? (
        <Button
          type="button"
          className="max-sm:w-full"
          loading={busy === "accept"}
          disabled={busy !== null && busy !== "accept"}
          onClick={() => void act({ action: "accept", id: offer.id }, t("acceptedToast"))}
          data-testid="offer-accept"
        >
          <BadgeCheck aria-hidden="true" />
          {t("acceptAmount", { amount: price(offer.counter ?? offer.amount) })}
        </Button>
      ) : null}
      <Button
        type="button"
        variant={offer.status === "countered" ? "outline" : "ghost"}
        className="max-sm:w-full"
        loading={busy === "withdraw"}
        disabled={busy !== null && busy !== "withdraw"}
        onClick={() => void act({ action: "withdraw", id: offer.id }, t("withdrawnToast"))}
        data-testid="offer-withdraw"
      >
        {t("withdraw")}
      </Button>
    </div>
  ) : null;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(frame, accepted ? "border-structure/25" : myTurn ? "border-primary/40 ring-1 ring-primary/15" : null)}
      data-testid="offer-card"
      data-status={offer.status}
      data-role={buyer ? "buyer" : "seller"}
    >
      <div className="flex items-start gap-3">
        {badge}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 id={`${id}-title`} className="font-semibold text-pretty tabular-nums">
            {title}
          </h3>
          {detail ? <p className="text-sm text-foreground-muted tabular-nums">{detail}</p> : null}
          {expiry}
        </div>
      </div>
      {actions}
      <OfferNotice />
      {error ? <InlineError>{error}</InlineError> : null}
    </section>
  );
}
