"use client";

import { useState } from "react";
import { ExternalLink, Truck, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { SITE_NAME } from "@/config/site";
import { apiPost, isApiError } from "@/lib/auth/client";
import { SELLER_PAYMENT_API } from "@/lib/contracts/endpoints";
import type { OpenPaymentResponse, PublicShopPayment } from "@/lib/contracts/seller-payment";
import { cn } from "@/lib/utils";

// « Payer chez le vendeur » (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §2)
// on a Pro's listing and storefront. The cached page never holds the link: opening the dialog asks
// the API for it, which checks the shop's state, a suspension and the allowlist at that moment.
// The dialog says who handles the payment before the buyer leaves; the link opens in a new tab,
// without referrer, and is never followed by crawlers (nofollow). Nothing is added to the link.

/** First-strong isolate: a Latin shop name inside an Arabic sentence keeps the brackets around it in place. */
const isolate = (text: string) => `\u2068${text}\u2069`;

export function CashOnDeliveryBadge({ className }: { className?: string }) {
  const t = useTranslations("SellerPayment.public");
  return (
    <p className={cn("inline-flex w-fit items-center gap-2 rounded-sm bg-success-surface px-2.5 py-1.5 text-sm font-medium text-success", className)}>
      <Truck aria-hidden="true" className="size-4 shrink-0" />
      {t("cashOnDelivery")}
    </p>
  );
}

export function PayAtSeller({ payment, listingId, className }: { payment: PublicShopPayment; listingId?: string; className?: string }) {
  const t = useTranslations("SellerPayment.public");
  const apiMessage = useApiErrorMessage();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<OpenPaymentResponse | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(false);

  async function ask() {
    setLoading(true);
    setFailure(undefined);
    try {
      setLink(await apiPost<OpenPaymentResponse>(SELLER_PAYMENT_API.open(payment.proId), listingId ? { listingId } : {}));
    } catch (error) {
      setFailure(error);
    } finally {
      setLoading(false);
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && !link && !loading) void ask();
  }

  const host = link?.host ?? payment.host ?? "";
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {payment.cashOnDelivery ? <CashOnDeliveryBadge /> : null}
      {payment.online ? (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
          <Dialog.Trigger asChild>
            <Button type="button" variant="structure" className="w-full">
              <Wallet aria-hidden="true" className="size-5" />
              {t("button")}
            </Button>
          </Dialog.Trigger>
          <p className="text-xs text-foreground-muted text-pretty">{t("short", { shop: isolate(payment.shopName), site: SITE_NAME })}</p>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
            <Dialog.Content
              className={cn(
                "fixed inset-x-4 bottom-4 z-50 flex flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-xl shadow-bab-950/20 outline-none",
                "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 rtl:sm:translate-x-1/2",
                "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
              )}
            >
              <Dialog.Title className="text-lg font-semibold text-balance">{t("title", { site: SITE_NAME })}</Dialog.Title>
              <Dialog.Description asChild>
                <div className="flex flex-col gap-3 text-sm text-pretty">
                  <p>{t("handledBy", { shop: isolate(link?.shopName ?? payment.shopName), ice: link?.ice ?? payment.ice })}</p>
                  <p className="font-medium">{t("noGuarantee", { site: SITE_NAME })}</p>
                  {host ? (
                    <p>
                      {t.rich("checkHost", {
                        host,
                        b: (chunks) => (
                          <bdi dir="ltr" className="font-semibold">
                            {chunks}
                          </bdi>
                        ),
                      })}
                    </p>
                  ) : null}
                </div>
              </Dialog.Description>
              {failure !== undefined ? <FormMessage error={failure} title={isApiError(failure, "payment_unavailable", "not_found") ? t("unavailable") : apiMessage(failure)} /> : null}
              {/* Stacked, full width: the host in the main button can be long. */}
              <div className="mt-2 flex flex-col-reverse gap-2">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline">
                    {t("write")}
                  </Button>
                </Dialog.Close>
                {link ? (
                  <Button asChild variant="structure">
                    <a href={link.url} target="_blank" rel="noopener noreferrer nofollow" onClick={() => setOpen(false)} className="h-auto min-h-11 whitespace-normal text-center">
                      <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{t("continue", { host: link.host })}</span>
                      <ExternalLink aria-hidden="true" className="size-4" />
                    </a>
                  </Button>
                ) : failure === undefined ? (
                  <Button type="button" variant="structure" loading>
                    {t("continue", { host })}
                  </Button>
                ) : null}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </div>
  );
}
