"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { formatWait } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRouter } from "@/i18n/navigation";
import type { SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { submitSearchChallenge, type ChallengeOutcome } from "./challenge-client";
import { useSearchNavigation } from "./search-navigation";

// Shown in place of the results when this visitor went past the search limits without a pass
// (design D13, 403 `turnstile_required`): one Turnstile check (action "search"), then the same
// search through the API, which sets the pass, then the page renders again with the results.

type State = { kind: "idle" } | { kind: "checking" } | { kind: "refreshing" } | Exclude<ChallengeOutcome, { kind: "passed" }>;

export function SearchChallenge({ params, className }: { params: SearchParams; className?: string }) {
  const t = useTranslations("SearchPage.challenge");
  const locale = useLocale();
  const router = useRouter();
  const navigation = useSearchNavigation();
  const widget = useRef<TurnstileHandle>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [localPending, startTransition] = useTransition();
  const rendering = navigation ? navigation.pending : localPending;
  const busy = state.kind === "checking" || state.kind === "refreshing";

  // Still mounted once the page rendered again: the pass did not hold (cookies blocked).
  const sawRendering = useRef(false);
  useEffect(() => {
    if (state.kind !== "refreshing") return;
    if (rendering) sawRendering.current = true;
    else if (sawRendering.current) {
      sawRendering.current = false;
      setState({ kind: "error" });
    }
  }, [state.kind, rendering]);

  async function onToken(token: string | null) {
    if (!token || busy) return;
    setState({ kind: "checking" });
    const outcome = await submitSearchChallenge(params, token);
    if (outcome.kind === "passed") {
      setState({ kind: "refreshing" });
      if (navigation) navigation.refresh();
      else startTransition(() => router.refresh());
      return;
    }
    setState(outcome);
  }

  // Tokens are single use: a new check, on request only (the development widget answers at once,
  // so an automatic reset after a refusal would loop).
  function again() {
    setState({ kind: "idle" });
    widget.current?.reset();
  }

  return (
    <section data-testid="search-challenge" aria-labelledby="search-challenge-title" className={cn("mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-12 text-center", className)}>
      <span className="flex size-14 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
        <ShieldCheck className="size-6" aria-hidden="true" strokeWidth={1.75} />
      </span>
      <h2 id="search-challenge-title" className="text-xl font-semibold text-balance">
        {t("title")}
      </h2>
      <p className="text-foreground-muted text-pretty">{t("body")}</p>
      {state.kind === "limited" ? (
        <InlineError>{t("limited", { wait: formatWait(locale, state.retryAfter, t("later")) })}</InlineError>
      ) : (
        <TurnstileWidget ref={widget} action="search" cData="search-page" onToken={onToken} className="w-full max-w-xs" />
      )}
      {busy ? (
        <p role="status" className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner />
          {t("checking")}
        </p>
      ) : null}
      {state.kind === "failed" || state.kind === "error" ? (
        <div className="flex flex-col items-center gap-3">
          <InlineError>{state.kind === "failed" ? t("failed") : t("error")}</InlineError>
          <Button type="button" variant="outline" onClick={again}>
            {t("again")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
