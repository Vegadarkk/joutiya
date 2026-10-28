"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { loadPublicConfig, usePublicConfig } from "@/lib/config/client";
import type { PublicAdsConfig } from "@/lib/config/public-types";
import { applyConsentMode } from "@/lib/consent/consent-mode";
import { consentCookieString, normalizeChoice, parseConsent, readConsentCookie, type ConsentChoice } from "@/lib/consent/cookie";
import { isEeaUkCh, visitorCountry } from "@/lib/consent/region";

// Cookie consent state of the page (phase 6, D1-D3, D5). The banner appears only while a
// non-exempt tracker can run (`ads.mode` not "off"), the visitor has no valid choice yet, and
// Google's own consent message does not handle them (EEA/UK/CH once `ads.cmpEea` is on). The
// panel ("Gérer mes cookies" in the footer) opens from any page, trackers or not.

/** Fired on `window` with the new choice, for code outside React (the ad loader). */
export const CONSENT_EVENT = "jt-consent";

interface ConsentState {
  /** The visitor's choice; null = none yet (or not read yet, see `ready`). */
  choice: ConsentChoice | null;
  /** The cookie has been read (client only). */
  ready: boolean;
  save: (ads: boolean, perso: boolean) => void;
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
}

const ConsentContext = createContext<ConsentState | null>(null);

const ConsentBanner = dynamic(() => import("./consent-banner").then((module) => module.ConsentBanner), { ssr: false });
const ConsentPanel = dynamic(() => import("./consent-panel").then((module) => module.ConsentPanel), { ssr: false });

/** True when this visitor must get the banner: a tracker is configured and Google's message does not cover them. */
async function bannerNeeded(ads: PublicAdsConfig): Promise<boolean> {
  if (ads.mode === "off") return false;
  if (!ads.cmpEea) return true;
  return !isEeaUkCh(await visitorCountry());
}

// The cookie as an external store: read after hydration (the server has no choice to render),
// re-read after a save. The snapshot is the raw value when it is still valid, else "".
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function cookieSnapshot(): string {
  const raw = readConsentCookie(document.cookie);
  return raw && parseConsent(raw, Date.now() / 1000) ? raw : "";
}
const serverSnapshot = (): null => null;

export function ConsentProvider({ children }: { children: ReactNode }) {
  const raw = useSyncExternalStore(subscribe, cookieSnapshot, serverSnapshot);
  const ready = raw !== null;
  const choice = useMemo(() => (raw ? parseConsent(raw) : null), [raw]);
  const [banner, setBanner] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    // A valid choice needs no configuration: the banner stays away without a request.
    if (!ready || choice) return;
    let active = true;
    loadPublicConfig()
      .then((config) => bannerNeeded(config.ads))
      .then(
        (needed) => active && setBanner(needed),
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [ready, choice]);

  const save = useCallback((ads: boolean, perso: boolean) => {
    const next = normalizeChoice(ads, perso, Date.now() / 1000);
    document.cookie = consentCookieString(next, window.location.protocol === "https:");
    for (const listener of listeners) listener();
    setPanelOpen(false);
    applyConsentMode(next);
    window.dispatchEvent(new CustomEvent<ConsentChoice>(CONSENT_EVENT, { detail: next }));
  }, []);

  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const value = useMemo<ConsentState>(() => ({ choice, ready, save, panelOpen, openPanel, closePanel }), [choice, ready, save, panelOpen, openPanel, closePanel]);

  return (
    <ConsentContext.Provider value={value}>
      {children}
      {banner && !choice && !panelOpen ? <ConsentBanner /> : null}
      {panelOpen ? <ConsentPanel /> : null}
    </ConsentContext.Provider>
  );
}

export function useConsent(): ConsentState {
  const context = useContext(ConsentContext);
  if (!context) throw new Error("useConsent outside ConsentProvider");
  return context;
}

/** The ad settings for the panel: from the seeded configuration, or fetched once it opens. */
export function useAdsConfig(): PublicAdsConfig | null {
  return usePublicConfig()?.ads ?? null;
}
