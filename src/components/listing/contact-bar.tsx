"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { LogIn, MessageCircle, MessageSquare, Phone, RotateCw, Settings2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { loadWithRetry } from "@/components/layout/chunk-retry";
import { Button } from "@/components/ui/button";
import { getPathname, Link } from "@/i18n/navigation";
import { ApiError, apiPost, loadSession, useSession } from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";
import { LISTING_API } from "@/lib/contracts/endpoints";
import type { PhoneRevealResponse } from "@/lib/contracts/listings";
import { isolateLtr } from "@/lib/i18n/bidi";
import { findListingConversation } from "@/lib/messaging/client";
import { cn } from "@/lib/utils";
import type { RevealChallengeProps, RevealErrorProps } from "./contact-feedback";
import type { MessageDialogProps } from "./message-dialog";
import { isWhatsappUrl, revealFailure } from "./reveal";

export { isWhatsappUrl, REVEAL_ERROR_KEYS, revealFailure, type RevealErrorKey } from "./reveal";

// Contact actions of a published listing (design §5, phase-5 U1): the message button, which opens
// the buyer's conversation about the listing when there is one, else the first-message dialog
// (message-dialog.tsx, then /messages/{cid}), and the phone reveal island
// (POST /api/listings/{id}/phone with the phase 2 CSRF header; the number is never in the ISR HTML)
// with WhatsApp once revealed, both shown only when the seller offers them (no phone check while
// WhatsApp is parked, so messaging is then the only channel). Anonymous visitors get a sign-in link
// that brings them back here; the seller sees a link to their listings instead. On phones the
// actions sit in a bar fixed to the bottom of the screen; from lg they sit in the seller card. The
// dialog, the challenge and the refusal messages load on demand: most visitors never need them.
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
/** The dialog's chunk is missing: the reload request shows in the bar instead. */
function MessageDialogFallback(props: MessageDialogProps) {
  return props.open ? <RevealFeedbackFallback /> : null;
}
export const loadMessageDialog = loadWithRetry<MessageDialogProps>(() => import("./message-dialog").then((module) => module.MessageDialog), MessageDialogFallback);

const RevealChallenge = dynamic(() => loadRevealChallenge(), { ssr: false });
const RevealError = dynamic(() => loadRevealError(), { ssr: false });
const MessageDialog = dynamic(() => loadMessageDialog(), { ssr: false });

export interface ContactBarProps {
  listingId: string;
  /** Canonical `{slug}-{id}`: the `?next=` of the sign-in link. */
  slugId: string;
  /** Hides the actions from the seller looking at their own listing. */
  sellerPublicId: string;
  /** Title of the message dialog ("Écrire à {name}"). */
  sellerName?: string;
  /** Reminded in the message dialog. */
  listingTitle?: string;
  showPhone: boolean;
  whatsapp: boolean;
  /** Adults-only listing: the message dialog asks the buyer's 18+ confirmation. */
  adultsOnly?: boolean;
}

type Phone = PhoneRevealResponse["phone"];

export type MessageStep = { kind: "signin" } | { kind: "thread"; cid: string } | { kind: "compose" };

export interface MessageStepDeps {
  loadSession: () => Promise<SessionSummary | null>;
  findListingConversation: (listingId: string) => Promise<string | null>;
}

/**
 * What the message button does: sign in first, open the conversation the viewer already has about
 * the listing, or write the first message (also when that lookup fails). No phone check (D8).
 */
export async function messageStep(listingId: string, deps: MessageStepDeps = { loadSession, findListingConversation }): Promise<MessageStep> {
  const viewer = await deps.loadSession();
  if (!viewer) return { kind: "signin" };
  const cid = await deps.findListingConversation(listingId).catch(() => null);
  return cid ? { kind: "thread", cid } : { kind: "compose" };
}

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

export function ContactBar({ listingId, slugId, sellerPublicId, sellerName, listingTitle, showPhone, whatsapp, adultsOnly = false }: ContactBarProps) {
  const t = useTranslations("ListingPage.contact");
  const locale = useLocale();
  const { status, session } = useSession();
  const hintId = useId();
  const [state, setState] = useState<RevealState>({ kind: "idle" });
  /** closed; checking the session; signin: anonymous, the prompt shows; open: the dialog (mounted from then on). */
  const [compose, setCompose] = useState<"closed" | "checking" | "signin" | "open">("closed");
  const [composeMounted, setComposeMounted] = useState(false);
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

  async function openComposer() {
    if (compose === "checking") return;
    setCompose("checking");
    const step = await messageStep(listingId);
    if (step.kind === "signin") {
      setCompose("signin");
    } else if (step.kind === "thread") {
      // Another root layout (private pages): a document load either way. The button spins until then.
      window.location.assign(getPathname({ href: `/messages/${step.cid}`, locale }));
    } else {
      setComposeMounted(true);
      setCompose("open");
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

  // `compact`: the narrow half of the phone bar ("Message" instead of "Envoyer un message"); `wide`:
  // alone in the phone bar. The first action when it is the only one (no phone offered).
  const messageButton = (compact: boolean, wide = false) => (
    <Button
      type="button"
      variant={canReveal ? "outline" : "primary"}
      onClick={() => void openComposer()}
      loading={compose === "checking"}
      aria-describedby={hintId}
      aria-haspopup="dialog"
      className={cn(compact && "min-w-0 flex-1 px-3", wide && "min-w-0 flex-1")}
    >
      <MessageSquare aria-hidden="true" />
      {compact ? t("messageShort") : t("message")}
    </Button>
  );

  const signIn = (body: string) => (
    <div className="flex flex-col gap-2 rounded-md bg-surface-muted p-3 text-sm">
      <p className="text-pretty">{body}</p>
      <Button asChild variant="structure" className="self-start">
        <Link href={{ pathname: "/connexion", query: { next } }}>
          <LogIn aria-hidden="true" />
          {t("signIn")}
        </Link>
      </Button>
    </div>
  );

  const feedback = (inDesktopBlock: boolean) =>
    state.kind === "challenge" ? (
      inDesktopBlock === desktop ? (
        <RevealChallenge failed={state.failed} onToken={(token) => void reveal(token)} />
      ) : null
    ) : compose === "signin" ? (
      signIn(t("signInMessage"))
    ) : state.kind === "signin" ? (
      signIn(t("signInBody"))
    ) : state.kind === "error" ? (
      <RevealError error={state.error} />
    ) : null;

  const hint = (
    <p id={hintId} className="text-xs text-foreground-muted text-pretty">
      {t("messageHint")}
    </p>
  );

  return (
    <div data-testid="contact-bar">
      {/* lg and up: inside the seller card. */}
      <div className="hidden flex-col gap-3 lg:flex">
        {canReveal ? <div className="flex flex-col gap-2">{primary(false)}</div> : null}
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
            {revealed ? null : canReveal ? messageButton(true) : messageButton(false, true)}
            {canReveal ? primary(true) : null}
          </div>
        </div>
      </div>
      <BarSpacer />
      {composeMounted ? (
        <MessageDialog
          open={compose === "open"}
          onOpenChange={(open) => setCompose(open ? "open" : "closed")}
          listingId={listingId}
          listingTitle={listingTitle}
          sellerName={sellerName}
          adultsOnly={adultsOnly}
          onSignedOut={() => setCompose("signin")}
        />
      ) : null}
    </div>
  );
}
