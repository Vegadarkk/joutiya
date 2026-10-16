"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { useTheme } from "@/components/layout/theme";
import { usePublicConfig } from "@/lib/config/client";
import type { TurnstileAction } from "@/lib/contracts/auth";
import { cn } from "@/lib/utils";
import { loadScript } from "./load-script";

// Cloudflare Turnstile, explicit rendering (https://developers.cloudflare.com/turnstile/).
// Without a site key (development) the widget renders nothing and hands the form a placeholder
// token: the server skips the check when it has no secret.

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const DEV_TURNSTILE_TOKEN = "dev";

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  /** Customer data, echoed by siteverify as `cdata` (up to 255 characters of [A-Za-z0-9_-]). */
  cData?: string;
  theme?: "light" | "dark" | "auto";
  language?: string;
  size?: "normal" | "compact" | "flexible";
  appearance?: "always" | "execute" | "interaction-only";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: (code?: string) => void;
  "timeout-callback"?: () => void;
}

interface TurnstileApi {
  render(container: HTMLElement | string, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export interface TurnstileHandle {
  /** Asks for a fresh token (tokens are single use: call it after every refused submission). */
  reset(): void;
}

interface TurnstileWidgetProps {
  /**
   * Turnstile action name: the server refuses a token solved for another action, so the value is
   * one of the shared `TURNSTILE_ACTIONS`, the same the route handler checks.
   */
  action: TurnstileAction;
  /** Where the widget sits (statistics only; `cdata` in siteverify): letters, digits, `_` and `-`. */
  cData?: string;
  nonce?: string;
  /** A token, or null when the previous one expired or the widget failed. */
  onToken: (token: string | null) => void;
  /** Validation message of the form (token missing at submit). */
  error?: ReactNode;
  className?: string;
}

export const TurnstileWidget = forwardRef<TurnstileHandle, TurnstileWidgetProps>(function TurnstileWidget(
  { action, cData, nonce, onToken, error, className },
  ref,
) {
  const config = usePublicConfig();
  // undefined: configuration still loading (public pages); null: no key configured.
  const siteKey = config ? config.turnstileSiteKey : undefined;
  const locale = useLocale();
  const { resolvedTheme } = useTheme();
  const t = useTranslations("Auth.common");
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const latest = useRef(onToken);
  const [failed, setFailed] = useState(false);
  // Exposed as data-turnstile for the end-to-end tests, which wait for a token before submitting.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    latest.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (siteKey === undefined) return;
    if (siteKey === null) {
      latest.current(DEV_TURNSTILE_TOKEN);
      return;
    }
    let cancelled = false;
    loadScript(TURNSTILE_SRC, nonce).then(
      () => {
        if (cancelled || !container.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          ...(cData ? { cData } : {}),
          theme: resolvedTheme,
          language: locale === "ar" ? "ar" : "fr",
          size: "flexible",
          callback: (token) => {
            setReady(true);
            latest.current(token);
          },
          "expired-callback": () => {
            setReady(false);
            latest.current(null);
          },
          "timeout-callback": () => {
            setReady(false);
            latest.current(null);
          },
          "error-callback": () => {
            setReady(false);
            setFailed(true);
            latest.current(null);
          },
        });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = undefined;
      }
    };
  }, [siteKey, action, cData, nonce, locale, resolvedTheme]);

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        if (widgetId.current && window.turnstile) {
          setFailed(false);
          setReady(false);
          window.turnstile.reset(widgetId.current);
        } else if (siteKey === null) {
          latest.current(DEV_TURNSTILE_TOKEN);
        }
      },
    }),
    [siteKey],
  );

  if (siteKey === null) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {/* 65 px: the widget's own height, reserved so the form does not jump when it appears. */}
      <div ref={container} role="group" aria-label={t("turnstileLabel")} data-turnstile={ready ? "ready" : "pending"} className="min-h-[65px]" />
      {failed ? <InlineError>{t("turnstileError")}</InlineError> : error ? <InlineError>{error}</InlineError> : null}
    </div>
  );
});
