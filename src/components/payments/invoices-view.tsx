"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, ExternalLink } from "lucide-react";
import { useLocale } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { textLinkClassName } from "@/components/ui/text-link";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { numbersLocale } from "@/i18n/params";
import type { InvoiceView, InvoicesResponse } from "@/lib/contracts/payments";
import { loadInvoices } from "@/lib/payments/client";
import { cn } from "@/lib/utils";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";

// /pro/factures (phase 7 design §7): the shop's latest Stripe invoices, newest first, each with
// Stripe's page and PDF. Older ones stay in Stripe's portal.

type State = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; data: InvoicesResponse };

const STATUS_BADGE: Record<InvoiceView["status"], "success" | "warning" | "danger" | "neutral"> = { paid: "success", open: "warning", uncollectible: "danger", void: "neutral" };

export function InvoicesView() {
  const t = useNumbersTranslations("Invoices");
  const apiMessage = useApiErrorMessage();
  const locale = useLocale() as Locale;
  const [state, setState] = useState<State>({ kind: "loading" });

  const date = useCallback((iso: string) => new Intl.DateTimeFormat(numbersLocale(locale), { dateStyle: "medium", timeZone: moroccoTimeZone(new Date(iso).getTime()) }).format(new Date(iso)), [locale]);

  const fetchInvoices = useCallback(async () => {
    try {
      setState({ kind: "ready", data: await loadInvoices() });
    } catch (error) {
      setState({ kind: "failed", error });
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetchInvoices();
  }, [fetchInvoices]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Link href="/pro/abonnement" className={cn("inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-link", textLinkClassName)}>
          <ArrowLeft aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
          {t("back")}
        </Link>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
          <p className="text-foreground-muted text-pretty">{t("lead")}</p>
        </div>
      </header>

      {state.kind === "loading" ? (
        <div aria-busy="true" aria-label={t("loading")} className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : state.kind === "failed" ? (
        <ErrorBanner
          title={t("failed")}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setState({ kind: "loading" });
                void fetchInvoices();
              }}
            >
              {t("retry")}
            </Button>
          }
        >
          {apiMessage(state.error)}
        </ErrorBanner>
      ) : state.data.invoices.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong p-8 text-center text-foreground-muted text-pretty">{t("empty")}</p>
      ) : (
        <section aria-label={t("caption")} className="flex flex-col gap-3">
          <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_9rem_8rem_auto] gap-6 px-5 text-xs font-medium text-foreground-muted sm:grid">
            <span>{t("number")}</span>
            <span className="text-end">{t("amount")}</span>
            <span>{t("state")}</span>
            <span className="w-24 text-end">{t("documents")}</span>
          </div>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {state.data.invoices.map((invoice) => (
              <li key={invoice.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_auto]">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium tabular-nums">{invoice.number ? <bdi>{invoice.number}</bdi> : t("noNumber")}</span>
                  <span className="text-sm text-foreground-muted">{date(invoice.issuedAt)}</span>
                </span>
                <span className="text-end font-semibold tabular-nums">{t("total", { amount: invoice.totalMinor / 100, currency: invoice.currency })}</span>
                <span className="col-start-1 sm:col-start-auto">
                  <Badge variant={STATUS_BADGE[invoice.status]}>{t(`statuses.${invoice.status}`)}</Badge>
                </span>
                <span className="flex w-24 items-center justify-end gap-1 justify-self-end">
                  {invoice.hostedUrl ? (
                    <Button asChild variant="ghost" size="icon" className="size-9">
                      <a href={invoice.hostedUrl} target="_blank" rel="noopener noreferrer" aria-label={`${t("view")} ${invoice.number ?? ""}`.trim()} title={t("view")}>
                        <ExternalLink aria-hidden="true" className="size-4" />
                      </a>
                    </Button>
                  ) : null}
                  {invoice.pdfUrl ? (
                    <Button asChild variant="ghost" size="icon" className="size-9">
                      <a href={invoice.pdfUrl} target="_blank" rel="noopener noreferrer" aria-label={`${t("pdf")} ${invoice.number ?? ""}`.trim()} title={t("pdf")}>
                        <Download aria-hidden="true" className="size-4" />
                      </a>
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-foreground-muted text-pretty">{t("older")}</p>
        </section>
      )}
    </div>
  );
}
