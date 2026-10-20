"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useLocale } from "next-intl";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { textLinkClassName } from "@/components/ui/text-link";
import type { PackCurrency } from "@/config/pricing";
import type { Locale } from "@/config/site";
import { getPathname, Link } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { isApiError } from "@/lib/auth/client";
import { MOROCCAN_CARD_YEARLY_CAP_MAD, type PackOffer, type PacksResponse } from "@/lib/contracts/payments";
import { checkoutPack, loadPacks } from "@/lib/payments/client";
import { cn } from "@/lib/utils";

// "Acheter des crédits" (phase 7 design §6): the packs of the buyer's card currency, what to know
// before paying (the provider's page, the Moroccan card's yearly allowance, the 14-day refund of
// unused credits), the CGV box and Turnstile. Paying opens RevenueCat's page; its success page
// sends the buyer back to the wallet, which waits for the credits.

type State = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; data: PacksResponse };

/** Codes the page explains in its own words (Packs.errors). */
const PACK_ERRORS = ["sales_closed", "price_changed", "turnstile_failed", "unavailable"] as const;

/** Price in major units, for ICU's number format (up to 2 decimals). */
const major = (minor: number) => Math.round(minor) / 100;

export function PackPicker({ contactEmail }: { contactEmail: string }) {
  const t = useNumbersTranslations("Packs");
  const apiMessage = useApiErrorMessage();
  const locale = useLocale() as Locale;
  const turnstile = useRef<TurnstileHandle>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [currency, setCurrency] = useState<PackCurrency>("MAD");
  const [choice, setChoice] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  // State changes only once the answer is in (the first render is already "loading").
  const fetchPacks = useCallback(async () => {
    try {
      setState({ kind: "ready", data: await loadPacks() });
    } catch (error) {
      setState({ kind: "failed", error });
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetchPacks();
  }, [fetchPacks]);

  function reload() {
    setState({ kind: "loading" });
    setChoice(null);
    void fetchPacks();
  }

  const messageOf = (error: unknown) => {
    const code = PACK_ERRORS.find((candidate) => isApiError(error, candidate));
    return code ? t(`errors.${code}`) : apiMessage(error);
  };

  if (state.kind === "loading") {
    return (
      <div aria-busy="true" aria-label={t("loading")} className="flex flex-col gap-6">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
        <Skeleton className="h-36 w-full" />
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <ErrorBanner
        title={t("failed")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t("retry")}
          </Button>
        }
      >
        {apiMessage(state.error)}
      </ErrorBanner>
    );
  }

  const { data } = state;
  const currencies = [...new Set(data.packs.map((pack) => pack.currency))];
  const shown = data.packs.filter((pack) => pack.currency === currency);
  const selected = shown.find((pack) => pack.id === choice);
  const buyable = data.salesOpen && data.available && shown.length > 0;
  // The lowest price per credit, marked only when it is strictly the lowest.
  const rates = shown.map((pack) => pack.priceMinor / pack.credits);
  const best = shown.length > 1 && rates.filter((rate) => rate === Math.min(...rates)).length === 1 ? shown[rates.indexOf(Math.min(...rates))]?.id : undefined;
  const problems = attempted ? { choice: !selected, terms: !terms, challenge: !token } : { choice: false, terms: false, challenge: false };

  async function pay() {
    setAttempted(true);
    if (!selected || !terms || !token) return;
    setPending(true);
    setFailure(undefined);
    try {
      const { url } = await checkoutPack(selected.id, selected.priceMinor, token);
      // RevenueCat's page; the button stays busy until the browser leaves.
      window.location.assign(url);
    } catch (error) {
      setPending(false);
      setFailure(error);
      // Tokens are single use.
      setToken(null);
      turnstile.current?.reset();
      if (isApiError(error, "price_changed", "sales_closed")) reload();
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Link href="/porte-monnaie" className={cn("inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-link", textLinkClassName)}>
          <ArrowLeft aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
          {t("back")}
        </Link>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
          <p className="text-foreground-muted text-pretty">
            {data.account === "shop" ? t("shop") : t("personal")} {t("current", { count: data.wallet.balance })}
          </p>
        </div>
      </header>

      {!data.salesOpen ? <ErrorBanner tone="info" title={t("closed")} /> : null}
      {data.salesOpen && !data.available ? <ErrorBanner tone="warning" title={t("unavailable")} /> : null}

      {buyable ? (
        <form
          noValidate
          className="flex flex-col gap-8"
          onSubmit={(event) => {
            event.preventDefault();
            void pay();
          }}
        >
          {currencies.length > 1 ? (
            <fieldset className="flex flex-col gap-2.5">
              <legend className="mb-2.5 text-sm font-medium">{t("currency.legend")}</legend>
              <div className="flex flex-wrap gap-2">
                {currencies.map((code) => (
                  <label key={code} className={cn("cursor-pointer rounded-md border px-3.5 py-2 text-sm font-medium transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring", currency === code ? "border-primary bg-primary/5" : "border-border hover:border-border-strong")}>
                    <input
                      type="radio"
                      name="pack-currency"
                      value={code}
                      checked={currency === code}
                      onChange={() => {
                        setCurrency(code);
                        setChoice(null);
                      }}
                      className="sr-only"
                    />
                    {t(`currency.${code}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <fieldset className="flex flex-col gap-3" aria-invalid={problems.choice ? true : undefined}>
            <legend className="mb-3 text-lg font-semibold">{t("legend")}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {shown.map((pack) => (
                <PackCard key={pack.id} pack={pack} best={pack.id === best} selected={pack.id === choice} onSelect={() => setChoice(pack.id)} />
              ))}
            </div>
            {problems.choice ? <InlineError>{t("choose")}</InlineError> : null}
          </fieldset>

          <section aria-labelledby="packs-notes" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted p-5">
            <h2 id="packs-notes" className="font-semibold">
              {t("notesTitle")}
            </h2>
            <ul className="flex list-disc flex-col gap-2 ps-5 text-sm text-pretty marker:text-foreground-muted">
              <li>{t("notes.provider")}</li>
              {currency === "MAD" ? <li>{t("notes.moroccanCard", { cap: MOROCCAN_CARD_YEARLY_CAP_MAD })}</li> : null}
              <li>{t("notes.credits", { email: contactEmail })}</li>
            </ul>
          </section>

          <div className="flex flex-col gap-4">
            <label className="flex cursor-pointer items-start gap-3 text-sm text-pretty">
              <input type="checkbox" checked={terms} aria-invalid={problems.terms ? true : undefined} onChange={(event) => setTerms(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
              <span>
                {t("consent.terms")}{" "}
                <a href={getPathname({ href: "/legal/cgv", locale })} target="_blank" rel="noopener noreferrer" className={cn("font-medium", textLinkClassName)}>
                  {t("consent.termsLink")}
                </a>
              </span>
            </label>
            {problems.terms ? <InlineError>{t("consent.required")}</InlineError> : null}
            <TurnstileWidget ref={turnstile} action="pack-checkout" cData="pack-checkout" onToken={setToken} error={problems.challenge ? t("challenge") : undefined} />
          </div>

          {failure !== undefined ? <FormMessage error={failure} title={messageOf(failure)} /> : null}

          <div className="flex justify-end border-t border-border pt-6">
            <Button type="submit" variant="structure" loading={pending} className="w-full sm:w-auto">
              {selected ? t("submit", { amount: major(selected.priceMinor), currency: selected.currency }) : t("submitIdle")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function PackCard({ pack, best, selected, onSelect }: { pack: PackOffer; best: boolean; selected: boolean; onSelect: () => void }) {
  const t = useNumbersTranslations("Packs");
  return (
    <label
      className={cn(
        "relative flex cursor-pointer flex-col gap-4 rounded-lg border bg-surface p-5 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
        selected ? "border-primary bg-primary/5" : "border-border hover:border-border-strong",
      )}
    >
      <input type="radio" name="credit-pack" value={pack.id} checked={selected} onChange={onSelect} className="sr-only" />
      <span className="flex flex-col gap-1">
        <span className="text-lg leading-tight font-medium">
          {t.rich("credits", { count: pack.credits, n: (chunks) => <span className="text-4xl font-semibold tracking-tight tabular-nums">{chunks}</span> })}
        </span>
        {pack.bonus > 0 ? <span className="text-sm font-medium text-structure dark:text-gold-300">{t("bonus", { count: pack.bonus })}</span> : <span className="text-sm text-foreground-muted">{t("noBonus")}</span>}
      </span>
      <span className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
        <span className="text-lg font-semibold tabular-nums">{t("price", { amount: major(pack.priceMinor), currency: pack.currency })}</span>
        <span className="text-xs text-foreground-muted tabular-nums">{t("perCredit", { amount: Math.round(pack.priceMinor / pack.credits) / 100, currency: pack.currency })}</span>
      </span>
      {best ? <span className="absolute -top-2.5 end-4 rounded-sm bg-featured px-1.5 py-0.5 text-xs font-medium text-featured-foreground">{t("bestValue")}</span> : null}
    </label>
  );
}
