"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { apiPost } from "@/lib/auth/client";
import { SEARCH_API } from "@/lib/contracts/search";

// Page challenge of the SSR limits (design D14): Turnstile ("pages"), POST the token for the
// 30-minute pass, then back to the page the visitor asked for. A full navigation, so the proxy
// sees the new cookie on the very next request.

type State = { kind: "waiting" } | { kind: "sending" } | { kind: "done" } | { kind: "failed"; message: string };

export function PageChallenge({ next, nonce }: { next: string; nonce?: string }) {
  const t = useTranslations("Challenge");
  const apiMessage = useApiErrorMessage();
  const widget = useRef<TurnstileHandle>(null);
  const busy = useRef(false);
  const [state, setState] = useState<State>({ kind: "waiting" });

  const onToken = useCallback(
    async (token: string | null) => {
      if (!token || busy.current) return;
      busy.current = true;
      setState({ kind: "sending" });
      try {
        await apiPost(SEARCH_API.challengePass, { token });
        setState({ kind: "done" });
        window.location.replace(next);
      } catch (error) {
        // No automatic new check: the managed widget solves it again within a second, so a lasting
        // refusal (429, a configuration mismatch, the limiter down) would post in a loop.
        setState({ kind: "failed", message: apiMessage(error) });
      } finally {
        busy.current = false;
      }
    },
    [apiMessage, next],
  );

  // Tokens are single use: a fresh check, on request only.
  function again() {
    setState({ kind: "waiting" });
    widget.current?.reset();
  }

  return (
    <div className="flex flex-col gap-5">
      {/* When the widget cannot load, its own alert replaces the reserved box and the status line. */}
      <TurnstileWidget
        ref={widget}
        action="pages"
        cData="anti-robot"
        nonce={nonce}
        onToken={onToken}
        className="peer/turnstile has-[[role=alert]]:[&>[data-turnstile]]:min-h-0"
      />
      {/* The widget's own alert contradicts only the "waiting" hint: checking and done stay visible. */}
      <p
        role="status"
        aria-live="polite"
        className={`flex min-h-6 items-center gap-2 text-sm text-foreground-muted ${state.kind === "waiting" ? "peer-has-[[role=alert]]/turnstile:hidden" : ""}`}
      >
        {state.kind === "sending" ? (
          <>
            <Spinner />
            {t("checking")}
          </>
        ) : state.kind === "done" ? (
          t("done")
        ) : state.kind === "waiting" ? (
          t("waiting")
        ) : null}
      </p>
      {state.kind === "failed" ? (
        <ErrorBanner
          title={t("failedTitle")}
          action={
            <Button type="button" variant="outline" onClick={again}>
              {t("again")}
            </Button>
          }
        >
          {state.message}
        </ErrorBanner>
      ) : null}
      {state.kind === "done" ? (
        <Button asChild variant="structure" className="self-start">
          {/* Fallback when the automatic return is blocked. */}
          <a href={next}>{t("continue")}</a>
        </Button>
      ) : null}
    </div>
  );
}
