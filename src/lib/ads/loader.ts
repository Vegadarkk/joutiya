import { adsenseLoaderUrl } from "@/config/ads";

// Client-only AdSense loader (phase 6, D4): injected once, on the first slot allowed to request an
// ad, never in the HTML. Requests stay paused until the loader runs, with the personalisation
// choice set first.

interface AdsQueue extends Array<Record<string, never>> {
  pauseAdRequests?: 0 | 1;
  requestNonPersonalizedAds?: 0 | 1;
}

declare global {
  interface Window {
    adsbygoogle?: AdsQueue;
  }
}

let pending: Promise<void> | undefined;

function queue(): AdsQueue {
  window.adsbygoogle ??= [] as AdsQueue;
  return window.adsbygoogle;
}

/** Loads the AdSense script once; rejects when it cannot run (blocked, offline, CSP). */
export function loadAdsense(client: string, npa: 0 | 1 | undefined): Promise<void> {
  const ads = queue();
  if (npa !== undefined) ads.requestNonPersonalizedAds = npa;
  pending ??= new Promise<void>((resolve, reject) => {
    ads.pauseAdRequests = 1;
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = adsenseLoaderUrl(client);
    script.onload = () => {
      queue().pauseAdRequests = 0;
      resolve();
    };
    script.onerror = () => {
      pending = undefined;
      script.remove();
      reject(new Error("adsense: loader failed"));
    };
    document.head.append(script);
  });
  return pending;
}

/** Asks AdSense to fill the next unfilled `<ins class="adsbygoogle">`. */
export function requestAd(): void {
  queue().push({});
}
