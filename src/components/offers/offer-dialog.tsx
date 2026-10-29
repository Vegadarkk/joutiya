"use client";

import { useId, useState, type FormEvent } from "react";
import { HandCoins, Send, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { Textarea } from "@/components/post/controls/textarea";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/feedback/inline-error";
import { OFFER_NOTE_MAX, type OfferResponse } from "@/lib/contracts/offers";
import { isolate } from "@/lib/i18n/bidi";
import { parsePriceInput } from "@/lib/listings/client/format";
import { postOfferAction } from "@/lib/offers/client";
import { cn } from "@/lib/utils";
import { AmountField, amountProblem } from "./amount-field";
import { OfferNotice } from "./offer-notice";
import { useOfferErrorMessage } from "./errors";

// The thread's offer form in a sheet (mobile) or a dialog (Carte vivante lot 5): the buyer's offer,
// or the seller's counter-offer to the open offer `answering`. An optional note goes with it as an
// ordinary message. Posts to /api/conversations/{cid}/offer.

export interface OfferDialogProps {
  cid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  counterpartName: string;
  /** The price the bounds are measured against (DH). */
  price: number;
  /** A counter-offer to this open offer (seller); absent: a new offer (buyer). */
  answering?: { id: string; amount: number };
  onDone: (response: OfferResponse) => void;
}

export function OfferDialog({ cid, open, onOpenChange, counterpartName, price, answering, onDone }: OfferDialogProps) {
  const t = useTranslations("Offers.dialog");
  const errorMessage = useOfferErrorMessage();
  const id = useId();
  const counter = answering !== undefined;
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = amountProblem(amount, price, answering?.amount);
  const noteProblem = /[⟦⟧]/.test(note);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setTried(true);
    const value = parsePriceInput(amount);
    if (problem || value === null || noteProblem) return;
    setBusy(true);
    setError(null);
    const words = note.trim();
    try {
      const response = await postOfferAction(
        cid,
        answering ? { action: "counter", id: answering.id, amount: value, ...(words ? { note: words } : {}) } : { action: "make", amount: value, ...(words ? { note: words } : {}) },
      );
      onDone(response);
      onOpenChange(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="offer-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-y-auto rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-5 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-t-full rounded-b-sm bg-primary/12 text-primary">
                  <HandCoins className="size-5" />
                </span>
                <div className="flex flex-col gap-1">
                  <Dialog.Title className="text-xl font-semibold text-balance">{counter ? t("counterTitle", { name: isolate(counterpartName) }) : t("makeTitle", { name: isolate(counterpartName) })}</Dialog.Title>
                  <Dialog.Description className="text-sm text-foreground-muted text-pretty">{counter ? t("counterLead", { name: isolate(counterpartName) }) : t("makeLead", { name: isolate(counterpartName) })}</Dialog.Description>
                </div>
              </div>
              <Dialog.Close
                type="button"
                className="-me-2 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-foreground-muted hover:bg-surface-muted hover:text-foreground"
                aria-label={t("close")}
              >
                <X className="size-5" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <AmountField
              price={price}
              above={answering?.amount}
              value={amount}
              onChange={(value) => {
                setAmount(value);
                setError(null);
              }}
              problem={tried ? problem : null}
              label={counter ? t("counterAmount") : t("amount")}
              disabled={busy}
            />

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-note`} className="text-sm font-medium">
                {t("note")}
              </label>
              <Textarea
                id={`${id}-note`}
                rows={2}
                dir="auto"
                value={note}
                maxLength={OFFER_NOTE_MAX}
                placeholder={t("notePlaceholder")}
                aria-invalid={tried && noteProblem ? true : undefined}
                className="min-h-16 resize-none"
                onChange={(event) => setNote(event.target.value)}
              />
              {tried && noteProblem ? <InlineError>{t("reserved")}</InlineError> : null}
            </div>

            <OfferNotice />

            {error ? <InlineError>{error}</InlineError> : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Dialog.Close asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  {t("cancel")}
                </Button>
              </Dialog.Close>
              <Button type="submit" loading={busy} data-testid="offer-submit">
                <Send className="rtl:-scale-x-100" aria-hidden="true" />
                {counter ? t("sendCounter") : t("send")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
