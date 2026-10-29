"use client";

import { useId, useState } from "react";
import { Clock, KeyRound, Wallet } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PAYMENT_URL_MAX, paymentLinkHost, type PaymentLinkProblem } from "@/config/seller-payments";
import type { Locale } from "@/config/site";
import { useRouter } from "@/i18n/navigation";
import { isApiError, signOut } from "@/lib/auth/client";
import type { OwnerListingSummary, OwnerPaymentLink } from "@/lib/contracts/listings";
import type { PaymentLinkIssue } from "@/lib/contracts/seller-payment";
import { isolate } from "@/lib/i18n/bidi";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";
import { savePaymentLink } from "@/lib/listings/client/api";
import { intlLocale } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// "Mes annonces" row of a published or paused Pro listing (catalogue §6): its own « Payer chez le
// vendeur » link over the shop's, on a payment site Joutiya already checked. A new link needs a
// recent sign-in, is mailed to the owner and opens 24 hours after saving; going back to the link
// in force or removing it is immediate. The server checks every rule again.

const PAYMENT_ROW_STATUSES: readonly OwnerListingSummary["status"][] = ["published", "paused"];

export function showsPaymentLink(listing: OwnerListingSummary): boolean {
  return listing.paymentLink !== undefined && PAYMENT_ROW_STATUSES.includes(listing.status);
}

function useDateTime(): (at: string) => string {
  const locale = useLocale() as Locale;
  return (at) => {
    const ms = new Date(at).getTime();
    return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: moroccoTimeZone(ms) }).format(ms);
  };
}

interface OwnerPaymentLinkProps {
  listing: OwnerListingSummary & { paymentLink: OwnerPaymentLink };
  title: string;
  onChanged: (listing: OwnerListingSummary) => void;
}

export function OwnerPaymentLinkRow({ listing, title, onChanged }: OwnerPaymentLinkProps) {
  const t = useTranslations("MyListings.paymentLink");
  const dateTime = useDateTime();
  const [open, setOpen] = useState(false);
  const { url, pending } = listing.paymentLink;
  const host = paymentLinkHost(url ?? undefined);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {pending ? (
        <p data-testid="owner-payment-link" className="inline-flex items-center gap-1.5 text-xs text-foreground-muted text-pretty">
          <Clock className="size-3.5 shrink-0" aria-hidden="true" />
          {t("pending", { host: pending.host, date: dateTime(pending.activeFrom) })}
        </p>
      ) : host ? (
        <p data-testid="owner-payment-link" className="text-xs text-foreground-muted text-pretty">
          {t("active", { host })}
        </p>
      ) : null}
      <Button type="button" variant="outline" size="sm" className="max-sm:h-11" aria-label={t("openOf", { title: isolate(title) })} onClick={() => setOpen(true)}>
        <Wallet aria-hidden="true" />
        {t("open")}
      </Button>
      {open ? <PaymentLinkDialog listing={listing} title={title} onClose={() => setOpen(false)} onChanged={onChanged} /> : null}
    </div>
  );
}

function PaymentLinkDialog({ listing, title, onClose, onChanged }: OwnerPaymentLinkProps & { onClose: () => void }) {
  const t = useTranslations("MyListings.paymentLink");
  const problems = useTranslations("SellerPayment.settings.link.problems");
  const apiMessage = useApiErrorMessage("listing");
  const dateTime = useDateTime();
  const router = useRouter();
  const descriptionId = useId();
  const { url, pending } = listing.paymentLink;
  const [value, setValue] = useState(pending?.url ?? url ?? "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const linkProblem = isApiError(failure, "payment_link_invalid") ? ((failure.details as PaymentLinkIssue | undefined)?.problem ?? "invalid") : null;
  const reauth = isApiError(failure, "recent_auth_required");
  const trimmed = value.trim();
  const unchanged = trimmed === (pending?.url ?? url ?? "");

  async function submit(next: string | null) {
    setSaving(true);
    setFailure(undefined);
    try {
      const response = await savePaymentLink(listing.id, { url: next });
      onChanged(response.listing);
      toast.success(next === null ? t("removed") : response.listing.paymentLink?.pending ? t("savedPending") : t("saved"));
      onClose();
    } catch (error) {
      setFailure(error);
    } finally {
      setSaving(false);
    }
  }

  async function signInAgain() {
    await signOut();
    router.replace({ pathname: "/connexion", query: { next: "/mes-annonces" } });
    router.refresh();
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !saving && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={descriptionId}
          data-testid="payment-link-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[88dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex flex-col gap-1.5 border-b border-border px-5 pt-5 pb-4 sm:px-6">
            <Dialog.Title className="text-lg font-semibold text-balance">{t("title", { title: isolate(title) })}</Dialog.Title>
            <Dialog.Description id={descriptionId} className="text-sm text-foreground-muted text-pretty">
              {t("lead")}
            </Dialog.Description>
          </div>

          <form
            id={`${descriptionId}-form`}
            noValidate
            className="flex flex-col gap-4 overflow-y-auto px-5 py-4 sm:px-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (!saving && trimmed && !unchanged) void submit(trimmed);
            }}
          >
            {pending ? (
              <p className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-2 text-sm text-pretty">
                <Clock className="mt-0.5 size-4 shrink-0 text-foreground-muted" aria-hidden="true" />
                {t("pending", { host: pending.host, date: dateTime(pending.activeFrom) })}
              </p>
            ) : null}
            <Field label={t("label")} hint={t("hint")} error={linkProblem ? problems(linkProblem as PaymentLinkProblem) : undefined}>
              <Input type="url" inputMode="url" dir="ltr" autoComplete="off" spellCheck={false} placeholder="https://" maxLength={PAYMENT_URL_MAX} value={value} onChange={(event) => setValue(event.target.value)} />
            </Field>
            {reauth ? (
              <ErrorBanner
                tone="warning"
                title={t("reauthTitle")}
                action={
                  <Button type="button" variant="outline" size="sm" onClick={() => void signInAgain()}>
                    <KeyRound aria-hidden="true" />
                    {t("reauth")}
                  </Button>
                }
              >
                {t("reauthBody")}
              </ErrorBanner>
            ) : failure !== undefined && !linkProblem ? (
              <p role="alert" className="rounded-md bg-danger-surface px-3 py-2 text-sm text-danger text-pretty">
                {apiMessage(failure)}
              </p>
            ) : null}
          </form>

          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
            <Dialog.Close asChild>
              <Button type="button" variant="outline" disabled={saving}>
                {t("cancel")}
              </Button>
            </Dialog.Close>
            {url || pending ? (
              <Button type="button" variant="danger" disabled={saving} onClick={() => void submit(null)}>
                {t("remove")}
              </Button>
            ) : null}
            <Button type="submit" form={`${descriptionId}-form`} loading={saving} disabled={!trimmed || unchanged}>
              {t("save")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
