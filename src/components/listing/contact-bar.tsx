"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { LogIn, MessageCircle, MessageSquare, Phone, RotateCw, Settings2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { loadWithRetry } from "@/components/layout/chunk-retry";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ApiError, apiPost, loadSession, useSession } from "@/lib/auth/client";
import { LISTING_API } from "@/lib/contracts/endpoints";
import type { PhoneRevealResponse } from "@/lib/contracts/listings";
import { isolateLtr } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import type { RevealChallengeProps, RevealErrorProps } from "./contact-feedback";
import { isWhatsappUrl, revealFailure } from "./reveal";

export { isWhatsappUrl, REVEAL_ERROR_KEYS, revealFailure, type RevealErrorKey } from "./reveal";

// Contact actions of a published listing (design §5): the phone reveal island (POST
// /api/listings/{id}/phone with the phase 2 CSRF header; the number is never in the ISR HTML),
// WhatsApp once revealed, and the message button kept visible but disabled until the messaging of
// phase 6. Anonymous visitors get a sign-in link that brings them back here. On phones the actions
// sit in a bar fixed to the bottom of the screen; from lg they sit in the seller card. The challenge
// and the refusal messages load on demand (contact-feedback.tsx): most visitors never need them.
// When their chunk cannot be downloaded (dropped connection, tab opened before a redeploy) the
// download is tried again, then the visitor is asked to reload (chunk-retry.tsx).

/** Stands in for the challenge or a refusal message while their chunk cannot be downloaded. */
export function RevealFeedbackFallback() {
  const t = useTranslations("ListingPage.contact");
  return (
    <div className="flex flex-col items-start gap-2">
      <InlineError>{t("errors.outdated")}</InlineError>
      <Button type="button" variant="outline" onClick={() => window.location.reload()}>
        <RotateCw aria-hidden="true" />
        {t("reload")}
      </Button>
    </div>
  );
}

export const loadRevealChallenge = loadWithRetry<RevealChallengeProps>(() => import("./contact-feedback").then((module) => module.RevealChallenge), RevealFeedbackFallback);
export const loadRevealError = loadWithRetry<RevealErrorProps>(() => import("./contact-feedback").then((module) => module.RevealError), RevealFeedbackFallback);

const RevealChallenge = dynamic(() => loadRevealChallenge(), { ssr: false });
const RevealError = dynamic(() => loadRevealError(), { ssr: false });

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

type RevealState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "signin" }
  /** The IP allowance is spent (escalation.ts): a Turnstile challenge, then the same request with its token. */
  | { kind: "challenge"; failed: boolean }
  | { kind: "revealed"; phone: Phone }
  | { kind: "error"; error: unknown };

const subscribeNever = () => () => {};

/** Tailwind `lg`: the actions sit in the seller card from here, in the fixed phone bar below. */
const DESKTOP_QUERY = "(min-width: 64rem)";

function subscribeDesktop(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** One layout renders the challenge: two Turnstile widgets would ask twice. */
function useDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches, () => false);
}

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
  const hintId = useId();
  const [state, setState] = useState<RevealState>({ kind: "idle" });
  const desktop = useDesktop();

  const canReveal = showPhone || whatsapp;
  const own = status === "ready" && session !== null && session.publicId === sellerPublicId;
  const next = `/${locale}/annonce/${slugId}`;

  async function reveal(turnstileToken?: string) {
    if (state.kind === "loading") return;
    setState({ kind: "loading" });
    const viewer = await loadSession();
    if (!viewer) {
      setState({ kind: "signin" });
      return;
    }
    try {
      const { phone } = await apiPost<PhoneRevealResponse>(LISTING_API.phone(listingId), turnstileToken ? { turnstileToken } : {});
      setState({ kind: "revealed", phone });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === "turnstile_required" || code === "turnstile_failed") {
        // A refused token is single use: the widget mounts again for a fresh one.
        setState({ kind: "challenge", failed: code === "turnstile_failed" || turnstileToken !== undefined });
        return;
      }
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
            <a href={`tel:${revealed.e164}`} aria-label={t("call", { number: isolateLtr(revealed.display) })}>
              <Phone aria-hidden="true" />
              <span dir="ltr" className="tabular-nums">
                {revealed.display}
              </span>
            </a>
          </Button>
        ) : null}
        {revealed.whatsappUrl && isWhatsappUrl(revealed.whatsappUrl) ? (
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

  const feedback = (inDesktopBlock: boolean) =>
    state.kind === "challenge" ? (
      inDesktopBlock === desktop ? (
        <RevealChallenge failed={state.failed} onToken={(token) => void reveal(token)} />
      ) : null
    ) : state.kind === "signin" ? (
      <div className="flex flex-col gap-2 rounded-md bg-surface-muted p-3 text-sm">
        <p className="text-pretty">{t("signInBody")}</p>
        <Button asChild variant="structure" className="self-start">
          <Link href={{ pathname: "/connexion", query: { next } }}>
            <LogIn aria-hidden="true" />
            {t("signIn")}
          </Link>
        </Button>
      </div>
    ) : state.kind === "error" ? (
      <RevealError error={state.error} />
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
        {feedback(true)}
        {messageButton(false)}
        {hint}
      </div>
      {/* Phones and tablets: fixed to the bottom of the screen (the page reserves the space). The
          hint above stays the description of both message buttons (aria-describedby may point at
          hidden text). Once revealed, the bar holds the call and WhatsApp actions only. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-10px_30px_-18px_rgb(11_30_31/0.35)] lg:hidden">
        <div className="mx-auto flex max-w-xl flex-col gap-2">
          {feedback(false)}
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
