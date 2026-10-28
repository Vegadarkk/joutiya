"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Clock, KeyRound, ShieldCheck, Wallet } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { InlineError } from "@/components/feedback/inline-error";
import { Textarea } from "@/components/post/controls/textarea";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { textLinkClassName } from "@/components/ui/text-link";
import { SELLER_INFO_LIMITS, type PaymentLinkProblem } from "@/config/seller-payments";
import { SITE_NAME, type Locale } from "@/config/site";
import { Link, useRouter } from "@/i18n/navigation";
import { numbersLocale } from "@/i18n/params";
import { apiGet, apiPut, isApiError, signOut } from "@/lib/auth/client";
import { SELLER_PAYMENT_API, type PaymentLinkIssue, type SellerPaymentInput, type SellerPaymentView } from "@/lib/contracts/seller-payment";
import { cn } from "@/lib/utils";

// /pro/paiement (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §2): the owner
// links its own payment page and/or accepts cash on delivery, and fills the distance seller's
// information of law 31-08. A new link needs a recent sign-in, is mailed to the owner and turns
// active 24 hours later (after a review when its host is new to the platform).

type State = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; data: SellerPaymentView };
type InfoKey = keyof typeof SELLER_INFO_LIMITS;
const INFO_KEYS: readonly InfoKey[] = ["address", "email", "delivery", "returns"];

interface Draft {
  url: string;
  cashOnDelivery: boolean;
  info: Record<InfoKey, string>;
  terms: boolean;
}

function draftOf(data: SellerPaymentView): Draft {
  return {
    url: data.pending?.url ?? data.storedUrl ?? "",
    cashOnDelivery: data.cashOnDelivery,
    info: { address: data.info?.address ?? "", email: data.info?.email ?? "", delivery: data.info?.delivery ?? "", returns: data.info?.returns ?? "" },
    terms: data.info !== null,
  };
}

export function SellerPaymentSettings() {
  const t = useTranslations("SellerPayment.settings");
  const apiMessage = useApiErrorMessage();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      setState({ kind: "ready", data: await apiGet<SellerPaymentView>(SELLER_PAYMENT_API.me) });
    } catch (error) {
      setState({ kind: "failed", error });
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link href="/pro" className={cn("inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-link", textLinkClassName)}>
          <ArrowLeft aria-hidden="true" className="size-4 rtl:rotate-180" />
          {t("back")}
        </Link>
        <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
        <p className="max-w-prose text-foreground-muted text-pretty">{t("lead", { site: SITE_NAME })}</p>
      </div>
      {state.kind === "loading" ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : state.kind === "failed" ? (
        <ErrorBanner
          title={t("failed")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              {t("retry")}
            </Button>
          }
        >
          {apiMessage(state.error)}
        </ErrorBanner>
      ) : (
        <Settings data={state.data} onSaved={(data) => setState({ kind: "ready", data })} />
      )}
    </div>
  );
}

function Settings({ data, onSaved }: { data: SellerPaymentView; onSaved: (data: SellerPaymentView) => void }) {
  const t = useTranslations("SellerPayment.settings");
  const apiMessage = useApiErrorMessage();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(data));
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);
  const date = (iso: string) => new Intl.DateTimeFormat(numbersLocale(locale), { dateStyle: "long", timeStyle: "short", timeZone: "Africa/Casablanca" }).format(new Date(iso));

  const url = draft.url.trim();
  const turningOn = url !== "" || draft.cashOnDelivery;
  const missing = (key: InfoKey) => attempted && turningOn && draft.info[key].trim().length < (key === "email" ? 3 : 10);
  const termsMissing = attempted && turningOn && !draft.terms;
  const linkProblem = isApiError(failure, "payment_link_invalid") ? ((failure.details as PaymentLinkIssue | undefined)?.problem ?? "invalid") : null;

  async function save(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    setSaved(false);
    if (turningOn && (!draft.terms || INFO_KEYS.some((key) => draft.info[key].trim().length < (key === "email" ? 3 : 10)))) return;
    setPending(true);
    setFailure(undefined);
    const filled = INFO_KEYS.every((key) => draft.info[key].trim() !== "");
    const body: SellerPaymentInput = {
      url: url === "" ? null : url,
      cashOnDelivery: draft.cashOnDelivery,
      info: filled ? { address: draft.info.address.trim(), email: draft.info.email.trim(), delivery: draft.info.delivery.trim(), returns: draft.info.returns.trim() } : null,
      acceptTerms: draft.terms,
    };
    try {
      const next = await apiPut<SellerPaymentView>(SELLER_PAYMENT_API.me, body);
      setSaved(true);
      onSaved(next);
    } catch (error) {
      setFailure(error);
    } finally {
      setPending(false);
    }
  }

  async function signInAgain() {
    await signOut();
    router.replace({ pathname: "/connexion", query: { next: "/pro/paiement" } });
    router.refresh();
  }

  const setInfo = (key: InfoKey, value: string) => setDraft((current) => ({ ...current, info: { ...current.info, [key]: value } }));

  if (!data.eligible) {
    return (
      <ErrorBanner tone="info" title={t("ineligibleTitle")}>
        {t("ineligible")}
      </ErrorBanner>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {data.suspended ? (
        <ErrorBanner tone="danger" title={t("suspendedTitle")}>
          {t("suspended", { reason: data.suspended.reason })}
        </ErrorBanner>
      ) : null}

      <section aria-labelledby="payment-status" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5 sm:p-6">
        <h2 id="payment-status" className="text-sm font-medium text-foreground-muted">
          {t("status.title")}
        </h2>
        <p className="flex items-start gap-2.5 text-pretty">
          <Wallet aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-structure dark:text-gold-300" />
          {data.url ? (
            <span>
              {t.rich("status.active", { host: hostOf(data.url), b: (chunks) => <bdi dir="ltr" className="font-semibold">{chunks}</bdi> })}
            </span>
          ) : data.storedUrl ? (
            <span>{t.rich("status.withdrawn", { host: hostOf(data.storedUrl), site: SITE_NAME, b: (chunks) => <bdi dir="ltr" className="font-semibold">{chunks}</bdi> })}</span>
          ) : (
            <span>{t("status.none")}</span>
          )}
        </p>
        {data.pending ? (
          <p className="flex items-start gap-2.5 text-sm text-pretty">
            {data.pending.review ? <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-gold-500" /> : <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-gold-500" />}
            <span>
              {data.pending.review
                ? t.rich("status.review", { host: data.pending.host, b: (chunks) => <bdi dir="ltr" className="font-semibold">{chunks}</bdi> })
                : t.rich("status.pending", { host: data.pending.host, date: date(data.pending.activeFrom!), b: (chunks) => <bdi dir="ltr" className="font-semibold">{chunks}</bdi> })}
            </span>
          </p>
        ) : null}
        {data.hostRejected ? (
          <p className="text-sm text-danger text-pretty">{t("status.rejected", { host: data.hostRejected.host, reason: data.hostRejected.reason })}</p>
        ) : null}
        {data.cashOnDelivery ? <p className="text-sm text-pretty">{t("status.cash")}</p> : null}
      </section>

      <form noValidate onSubmit={(event) => void save(event)} className="flex flex-col gap-8">
        <fieldset className="flex flex-col gap-5">
          <legend className="mb-4 text-lg font-semibold">{t("link.title")}</legend>
          <Field label={t("link.label")} hint={t("link.hint")} error={linkProblem ? t(`link.problems.${linkProblem as PaymentLinkProblem}`) : undefined}>
            <Input type="url" inputMode="url" dir="ltr" autoComplete="off" spellCheck={false} placeholder="https://" value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} maxLength={500} />
          </Field>
          <label className="flex cursor-pointer items-start gap-3 text-sm text-pretty">
            <input type="checkbox" checked={draft.cashOnDelivery} onChange={(event) => setDraft((current) => ({ ...current, cashOnDelivery: event.target.checked }))} className="mt-0.5 size-4 shrink-0 accent-primary" />
            <span>
              <span className="font-medium">{t("cash.label")}</span>
              <span className="block text-foreground-muted">{t("cash.hint")}</span>
            </span>
          </label>
        </fieldset>

        <fieldset className="flex flex-col gap-5">
          <legend className="mb-1 text-lg font-semibold">{t("info.title")}</legend>
          <p className="-mt-2 mb-1 text-sm text-foreground-muted text-pretty">{t("info.lead")}</p>
          <Field label={t("info.address")} hint={t("info.addressHint")} required={turningOn} error={missing("address") ? t("info.required") : undefined}>
            <Textarea rows={2} className="min-h-20" value={draft.info.address} maxLength={SELLER_INFO_LIMITS.address} onChange={(event) => setInfo("address", event.target.value)} />
          </Field>
          <Field label={t("info.email")} required={turningOn} error={missing("email") ? t("info.required") : undefined}>
            <Input type="email" dir="ltr" autoComplete="email" value={draft.info.email} maxLength={SELLER_INFO_LIMITS.email} onChange={(event) => setInfo("email", event.target.value)} />
          </Field>
          <Field label={t("info.delivery")} hint={t("info.deliveryHint")} required={turningOn} error={missing("delivery") ? t("info.required") : undefined}>
            <Textarea rows={3} className="min-h-24" value={draft.info.delivery} maxLength={SELLER_INFO_LIMITS.delivery} onChange={(event) => setInfo("delivery", event.target.value)} />
          </Field>
          <Field label={t("info.returns")} hint={t("info.returnsHint")} required={turningOn} error={missing("returns") ? t("info.required") : undefined}>
            <Textarea rows={3} className="min-h-24" value={draft.info.returns} maxLength={SELLER_INFO_LIMITS.returns} onChange={(event) => setInfo("returns", event.target.value)} />
          </Field>
        </fieldset>

        <div className="flex flex-col gap-2">
          <label className="flex cursor-pointer items-start gap-3 text-sm text-pretty">
            <input type="checkbox" checked={draft.terms} aria-invalid={termsMissing ? true : undefined} onChange={(event) => setDraft((current) => ({ ...current, terms: event.target.checked }))} className="mt-0.5 size-4 shrink-0 accent-primary" />
            <span>{t("terms", { site: SITE_NAME })}</span>
          </label>
          {termsMissing ? <InlineError>{t("termsRequired")}</InlineError> : null}
        </div>

        {isApiError(failure, "recent_auth_required") ? (
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
          <FormMessage error={failure} title={isApiError(failure, "payment_info_required") ? t("infoRequired") : isApiError(failure, "pro_not_verified") ? t("ineligible") : apiMessage(failure)} />
        ) : null}
        {saved ? (
          <p role="status" className="rounded-md bg-success-surface px-4 py-3 text-sm text-success">
            {t("saved")}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" variant="structure" loading={pending} className="w-full sm:w-auto">
            {t("submit")}
          </Button>
        </div>
      </form>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
