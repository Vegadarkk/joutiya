"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { apiPost, setSession } from "@/lib/auth/client";
import { usePublicConfig } from "@/lib/config/client";
import { AUTH_API, type GoogleResponse, type SessionSummary } from "@/lib/contracts/auth";
import { cn } from "@/lib/utils";
import { InAppBrowserNotice, inAppBrowserName } from "./in-app-browser-notice";
import { loadScript } from "./load-script";

// Google Identity Services button (https://developers.google.com/identity/gsi/web): the Google ID
// token goes to POST /api/auth/google, which signs an existing account in or asks for the
// sign-up consents (`needs_consent`). Hidden when no OAuth client id is configured.

const GIS_SRC = "https://accounts.google.com/gsi/client";

interface GsiCredentialResponse {
  credential: string;
  select_by?: string;
}

interface GsiIdConfiguration {
  client_id: string;
  callback: (response: GsiCredentialResponse) => void;
  ux_mode?: "popup" | "redirect";
  use_fedcm_for_prompt?: boolean;
  nonce?: string;
  auto_select?: boolean;
  itp_support?: boolean;
}

interface GsiButtonConfiguration {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "large" | "medium" | "small";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number | string;
  locale?: string;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: GsiIdConfiguration): void;
          renderButton(parent: HTMLElement, options: GsiButtonConfiguration): void;
        };
      };
    };
  }
}

const noSubscription = () => () => {};
const readInApp = () => inAppBrowserName(navigator.userAgent);
const readServerInApp = (): string | null | undefined => undefined;

export interface GoogleNeedsConsent {
  credential: string;
  email: string;
  displayName: string | null;
}

interface GoogleButtonProps {
  nonce?: string;
  onSignedIn: (session: SessionSummary) => void;
  /** New Google account: the consents (and Turnstile) are needed before the account is created. */
  onNeedsConsent: (payload: GoogleNeedsConsent) => void;
  onError: (error: unknown) => void;
  /** Rendered under the button ("ou"), only when the button itself renders. */
  divider?: ReactNode;
  className?: string;
}

export function GoogleButton({ nonce, onSignedIn, onNeedsConsent, onError, divider, className }: GoogleButtonProps) {
  const config = usePublicConfig();
  const clientId = config?.googleClientId ?? null;
  const locale = useLocale();
  const t = useTranslations("Auth.common");
  const slot = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onSignedIn, onNeedsConsent, onError });
  // undefined on the server and during hydration; the webview name (or null) once on the client.
  const inApp = useSyncExternalStore(noSubscription, readInApp, readServerInApp);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    handlers.current = { onSignedIn, onNeedsConsent, onError };
  }, [onSignedIn, onNeedsConsent, onError]);

  useEffect(() => {
    if (!clientId || inApp !== null) return;
    let cancelled = false;
    async function submit(credential: string) {
      setBusy(true);
      try {
        const answer = await apiPost<GoogleResponse>(AUTH_API.google, { credential, locale });
        if (cancelled) return;
        if (answer.status === "signed_in") {
          setSession(answer.session);
          handlers.current.onSignedIn(answer.session);
        } else {
          handlers.current.onNeedsConsent({ credential, email: answer.email, displayName: answer.displayName });
        }
      } catch (error) {
        if (!cancelled) handlers.current.onError(error);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    loadScript(GIS_SRC, nonce).then(
      () => {
        const parent = slot.current;
        if (cancelled || !parent || !window.google) return;
        const id = window.google.accounts.id;
        id.initialize({
          client_id: clientId,
          ux_mode: "popup",
          use_fedcm_for_prompt: true,
          callback: (response) => void submit(response.credential),
        });
        // GIS accepts 200 to 400 px; the form column is 448 px at most.
        const width = Math.min(400, Math.max(200, Math.round(parent.clientWidth || 320)));
        id.renderButton(parent, {
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "pill",
          logo_alignment: "left",
          width,
          locale: locale === "ar" ? "ar" : "fr",
        });
        setRendered(true);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [clientId, inApp, nonce, locale]);

  if (!clientId) return null;
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {inApp === undefined ? (
        <div className="h-11" aria-hidden="true" />
      ) : inApp ? (
        <InAppBrowserNotice app={inApp} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="relative flex h-11 items-center justify-center" aria-busy={busy || undefined}>
            <div ref={slot} className="flex w-full justify-center" />
            {!rendered && !failed ? <Skeleton className="absolute inset-x-0 top-0.5 mx-auto h-10 max-w-sm rounded-full" /> : null}
            {!rendered && !failed ? <span className="sr-only">{t("googleLoading")}</span> : null}
            {busy ? (
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-surface/70">
                <Spinner className="text-foreground" />
              </div>
            ) : null}
          </div>
          {failed ? <InlineError>{t("googleError")}</InlineError> : null}
        </div>
      )}
      {divider}
    </div>
  );
}
