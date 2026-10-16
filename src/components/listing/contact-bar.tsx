"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LogIn, MessageCircle, MessageSquare, Phone, Settings2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { formatWait, useApiErrorMessage } from "@/components/auth/form-message";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ApiError, apiPost, loadSession, useSession, type ApiErrorCode } from "@/lib/auth/client";
import { LISTING_API, type PhoneRevealResponse } from "@/lib/contracts/listings";
import { cn } from "@/lib/utils";

// Contact actions of a published listing (design §5): the phone reveal island (POST
// /api/listings/{id}/phone with the phase 2 CSRF header; the number is never in the ISR HTML),
// WhatsApp once revealed, and the message button kept visible but disabled until the messaging of
// phase 6. Anonymous visitors get a sign-in link that brings them back here. On phones the actions
// sit in a bar fixed to the bottom of the screen; from lg they sit in the seller card.

export interface ContactBarProps {
  listingId: string;
  /** Canonical `{slug}-{id}`: the `?next=` of the sign-in link. */
  slugId: string;
  /** Hides the actions from the seller looking at their own listing. */
  sellerPublicId: string;
  showPhone: boolean;
  whatsapp: boolean;
}

type Phone = PhoneRevealResponse["phone"];

type RevealState = { kind: "idle" } | { kind: "loading" } | { kind: "signin" } | { kind: "revealed"; phone: Phone } | { kind: "error"; error: unknown };

/** Reveal refusals with a message of their own (src/lib/listings/phone-reveal.ts, escalation.ts, limiter). */
export const REVEAL_ERROR_KEYS = ["reveal_not_allowed", "listing_unavailable", "not_found", "turnstile_required", "turnstile_failed", "rate_limited", "unavailable", "network"] as const;
export type RevealErrorKey = (typeof REVEAL_ERROR_KEYS)[number];

/**
 * What the island does with a failed reveal: `signin` (session gone), one of the reveal messages,
 * or `null` for the generic API message (account suspended, internal error).
 */
export function revealFailure(error: unknown): "signin" | RevealErrorKey | null {
  const code: ApiErrorCode = error instanceof ApiError ? error.code : "internal";
  if (code === "unauthenticated") return "signin";
  // Turnstile cannot run on a public page (hash CSP): both escalation answers say "later".
  if (code === "turnstile_failed") return "turnstile_required";
  return (REVEAL_ERROR_KEYS as readonly string[]).includes(code) ? (code as RevealErrorKey) : null;
}

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

const subscribeNever = () => () => {};

/**
 * Room for the fixed phone bar after the footer (portalled to the end of <body>): without it the bar
 * would cover the last lines of the page. Client only, below the fold: no visible shift.
 */
function BarSpacer() {
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  return mounted ? createPortal(<div aria-hidden="true" data-testid="contact-bar-spacer" className="h-24 lg:hidden" />, document.body) : null;
}

export function ContactBar({ listingId, slugId, sellerPublicId, showPhone, whatsapp }: ContactBarProps) {
  const t = useTranslations("ListingPage.contact");
  const locale = useLocale();
  const { status, session } = useSession();
  const message = useRevealMessage();
  const hintId = useId();
  const [state, setState] = useState<RevealState>({ kind: "idle" });

  const canReveal = showPhone || whatsapp;
  const own = status === "ready" && session !== null && session.publicId === sellerPublicId;
  const next = `/${locale}/annonce/${slugId}`;

  async function reveal() {
    if (state.kind === "loading") return;
    setState({ kind: "loading" });
    const viewer = await loadSession();
    if (!viewer) {
      setState({ kind: "signin" });
      return;
    }
    try {
      const { phone } = await apiPost<PhoneRevealResponse>(LISTING_API.phone(listingId), {});
      setState({ kind: "revealed", phone });
    } catch (error) {
      setState(revealFailure(error) === "signin" ? { kind: "signin" } : { kind: "error", error });
    }
  }

  if (own) {
    return (
      <div data-testid="contact-bar" className="flex flex-col gap-3 rounded-md bg-surface-muted p-4">
        <p className="text-sm text-pretty">{t("own")}</p>
        <Button asChild variant="outline" className="self-start">
          <Link href="/mes-annonces">
            <Settings2 aria-hidden="true" />
            {t("manage")}
          </Link>
        </Button>
      </div>
    );
  }

  const revealLabel = showPhone ? t("showPhone") : t("showWhatsapp");
  const revealed = state.kind === "revealed" ? state.phone : null;

  const primary = (wide: boolean) =>
    revealed ? (
      <>
        {showPhone ? (
          <Button asChild className={cn(wide && "min-w-0 flex-1")}>
            <a href={`tel:${revealed.e164}`} aria-label={t("call", { number: revealed.display })}>
              <Phone aria-hidden="true" />
              <span dir="ltr" className="tabular-nums">
                {revealed.display}
              </span>
            </a>
          </Button>
        ) : null}
        {revealed.whatsappUrl ? (
          <Button asChild variant={showPhone ? "outline" : "primary"} className={cn(wide && "min-w-0 flex-1")}>
            <a href={revealed.whatsappUrl} target="_blank" rel="noopener noreferrer">
              <MessageCircle aria-hidden="true" />
              {t("whatsapp")}
            </a>
          </Button>
        ) : null}
      </>
    ) : (
      <Button type="button" onClick={() => void reveal()} loading={state.kind === "loading"} className={cn(wide && "min-w-0 flex-1")}>
        <Phone aria-hidden="true" />
        {revealLabel}
      </Button>
    );

  // `compact`: the narrow half of the phone bar ("Message" instead of "Envoyer un message").
  const messageButton = (compact: boolean) => (
    <Button type="button" variant="outline" disabled aria-describedby={hintId} className={cn(compact && "min-w-0 flex-1 px-3")}>
      <MessageSquare aria-hidden="true" />
      {compact ? t("messageShort") : t("message")}
      <span className="rounded-sm bg-featured px-1.5 py-0.5 text-xs font-medium text-featured-foreground">{t("soon")}</span>
    </Button>
  );

  const feedback =
    state.kind === "signin" ? (
      <div className="flex flex-col gap-2 rounded-md bg-surface-muted p-3 text-sm">
        <p className="text-pretty">{t("signInBody")}</p>
        <Button asChild variant="structure" size="sm" className="self-start">
          <Link href={{ pathname: "/connexion", query: { next } }}>
            <LogIn aria-hidden="true" />
            {t("signIn")}
          </Link>
        </Button>
      </div>
    ) : state.kind === "error" ? (
      <InlineError>{message(state.error)}</InlineError>
    ) : null;

  const hint = (
    <p id={hintId} className="text-xs text-foreground-muted text-pretty">
      {canReveal ? t("messagingSoon") : t("messagingSoonOnly")}
    </p>
  );

  if (!canReveal) {
    return (
      <div data-testid="contact-bar" className="flex flex-col gap-2">
        {messageButton(false)}
        {hint}
      </div>
    );
  }

  return (
    <div data-testid="contact-bar">
      {/* lg and up: inside the seller card. */}
      <div className="hidden flex-col gap-3 lg:flex">
        <div className="flex flex-col gap-2">{primary(false)}</div>
        {feedback}
        {messageButton(false)}
        {hint}
      </div>
      {/* Phones and tablets: fixed to the bottom of the screen (the page reserves the space). The
          hint above stays the description of both message buttons (aria-describedby may point at
          hidden text). Once revealed, the bar holds the call and WhatsApp actions only. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-10px_30px_-18px_rgb(11_30_31/0.35)] lg:hidden">
        <div className="mx-auto flex max-w-xl flex-col gap-2">
          {feedback}
          <div className="flex gap-2">
            {revealed ? null : messageButton(true)}
            {primary(true)}
          </div>
        </div>
      </div>
      <BarSpacer />
    </div>
  );
}
