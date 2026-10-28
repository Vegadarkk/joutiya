import type { ConsentChoice } from "./cookie";

// Google Consent Mode v2 (phase 6, D3): `dataLayer` and `gtag` exist before any Google script, with
// every purpose denied by default, then updated from the visitor's choice. gtag.js itself loads
// only with a Google Ads conversion tag (none at launch); AdSense follows its own controls (D4).

type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

type State = "granted" | "denied";

/** Consent Mode signals for a choice: storage from `ads`, personalisation and user data from `perso` (D1). */
export function consentModeState(choice: ConsentChoice | null): Record<"ad_storage" | "ad_user_data" | "ad_personalization" | "analytics_storage", State> {
  const state = (granted: boolean | undefined): State => (granted ? "granted" : "denied");
  return { ad_storage: state(choice?.ads), ad_user_data: state(choice?.perso), ad_personalization: state(choice?.perso), analytics_storage: "denied" };
}

/** Defines the queue with denied defaults on first call, then sends the choice as an update. */
export function applyConsentMode(choice: ConsentChoice | null): void {
  const queue = (window.dataLayer ??= []);
  if (!window.gtag) {
    // gtag.js reads `arguments` objects from the queue, not arrays (Google's snippet).
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      queue.push(arguments);
    };
    window.gtag("consent", "default", { ...consentModeState(null), wait_for_update: 500 });
  }
  window.gtag("consent", "update", consentModeState(choice));
}
