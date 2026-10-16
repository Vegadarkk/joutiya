"use client";

import { useEffect, useRef } from "react";

// Cloudflare Turnstile widget, rendered explicitly. The script is loaded once with the request
// nonce (private CSP: nonce + 'strict-dynamic'; frame-src already lists challenges.cloudflare.com).
// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: "light" | "dark" | "auto";
  language?: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
}

/** The widget API once api.js has run (no global augmentation: src/components/auth declares its own). */
const turnstileApi = (): TurnstileApi | undefined => (window as unknown as { turnstile?: TurnstileApi }).turnstile;

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileProps {
  siteKey: string;
  action: string;
  nonce?: string;
  onToken: (token: string) => void;
  /** Token expired or the widget failed: the parent drops the token it holds. */
  onReset?: () => void;
}

export function Turnstile({ siteKey, action, nonce, onToken, onReset }: TurnstileProps) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onToken, onReset });
  useEffect(() => {
    handlers.current = { onToken, onReset };
  });

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    const render = () => {
      const api = turnstileApi();
      if (cancelled || !container.current || !api) return;
      widgetId = api.render(container.current, {
        sitekey: siteKey,
        action,
        theme: "auto",
        language: "fr",
        callback: (token) => handlers.current.onToken(token),
        "expired-callback": () => handlers.current.onReset?.(),
        "error-callback": () => handlers.current.onReset?.(),
      });
    };
    if (turnstileApi()) {
      render();
    } else {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = SCRIPT_SRC;
        script.async = true;
        if (nonce) script.nonce = nonce;
        document.head.append(script);
      }
      script.addEventListener("load", render, { once: true });
    }
    return () => {
      cancelled = true;
      if (widgetId) turnstileApi()?.remove(widgetId);
    };
  }, [siteKey, action, nonce]);

  return <div ref={container} className="flex min-h-16 justify-center" />;
}
