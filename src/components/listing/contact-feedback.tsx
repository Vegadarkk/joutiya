"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatWait, useApiErrorMessage } from "@/components/auth/form-message";
import { TurnstileWidget } from "@/components/auth/turnstile-widget";
import { InlineError } from "@/components/feedback/inline-error";
import { ApiError } from "@/lib/auth/client";
import { revealFailure } from "./reveal";

// What the contact bar shows when a reveal does not go through: the Turnstile challenge and the
// refusal messages. Loaded on demand (next/dynamic in contact-bar.tsx): the API error catalogue and
// the Turnstile loader stay out of the listing page's first JavaScript.

function useRevealMessage(): (error: unknown) => string {
  const t = useTranslations("ListingPage.contact.errors");
  const generic = useApiErrorMessage();
  const locale = useLocale();
  return (error: unknown) => {
    const key = revealFailure(error);
    if (key === null || key === "signin") return generic(error);
    if (key === "rate_limited") return t("rate_limited", { wait: formatWait(locale, error instanceof ApiError ? error.retryAfter : undefined, t("later")) });
    return t(key);
  };
}

export function RevealError({ error }: { error: unknown }) {
  const message = useRevealMessage();
  return <InlineError>{message(error)}</InlineError>;
}

/** The IP allowance is spent (escalation.ts): a challenge, whose token goes with the same request. */
export function RevealChallenge({ failed, onToken }: { failed: boolean; onToken: (token: string) => void }) {
  const t = useTranslations("ListingPage.contact");
  return (
    <div data-testid="reveal-challenge" className="flex flex-col gap-2 rounded-md bg-surface-muted p-3 text-sm">
      <p className="text-pretty">{t("challenge")}</p>
      <TurnstileWidget
        // A refused token is single use: the widget mounts again for a fresh one.
        key={failed ? "retry" : "first"}
        action="listing"
        cData="listing-reveal"
        onToken={(token) => {
          if (token) onToken(token);
        }}
        error={failed ? t("challengeFailed") : undefined}
      />
    </div>
  );
}
