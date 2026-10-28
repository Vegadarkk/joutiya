"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useOptionalConsent } from "@/components/consent/consent-provider";
import { AD_FILL_TIMEOUT_MS, AD_FORMATS, AD_LABEL_HEIGHT, type AdFormat, type AdPlacement } from "@/config/ads";
import { adRequest, adsConfigured, type AdRequest } from "@/lib/ads/policy";
import { loadAdsense, requestAd } from "@/lib/ads/loader";
import { loadPublicConfig } from "@/lib/config/client";
import { visitorCountry } from "@/lib/consent/region";
import { cn } from "@/lib/utils";

// Client half of AdSlot: a box of fixed height (unit + label) from the first paint, holding the
// house promotion (children) until an ad is allowed, then the AdSense unit. Unfilled, blocked
// (loader error, CSP) or not filled within AD_FILL_TIMEOUT_MS: the promotion comes back. The
// height never changes, so neither path shifts the page (D6, D19).

export interface AdUnitProps {
  placement: AdPlacement;
  format: AdFormat;
  media?: string;
  hide?: string;
  eligible: boolean;
  labels: { ad: string; promo: string; promoRegion: string };
  className?: string;
  children: ReactNode;
}

function sameRequest(a: AdRequest | null, b: AdRequest | null): boolean {
  return a === b || (a !== null && b !== null && a.client === b.client && a.unit === b.unit && a.test === b.test && a.npa === b.npa);
}

export function AdUnit({ placement, format, media, hide, eligible, labels, className, children }: AdUnitProps) {
  const consent = useOptionalConsent();
  const ready = consent?.ready ?? false;
  const choice = consent?.choice ?? null;
  const [request, setRequest] = useState<AdRequest | null>(null);
  // Outcome of one request: a new request starts without one.
  const [outcome, setOutcome] = useState<{ of: AdRequest; filled: boolean } | null>(null);
  const boxRef = useRef<HTMLElement>(null);
  const insRef = useRef<HTMLModElement>(null);
  const { width, height } = AD_FORMATS[format];

  useEffect(() => {
    if (!eligible || !ready) return;
    if (media && !window.matchMedia(media).matches) return;
    // Never a clipped unit (AdSense policy): the box must hold the unit's full width.
    if ((boxRef.current?.clientWidth ?? 0) < width) return;
    let active = true;
    loadPublicConfig()
      .then(async (config) => (adsConfigured(config.ads, config.env) ? adRequest(format, { ads: config.ads, env: config.env, choice, country: await visitorCountry() }) : null))
      .then(
        (next) => active && setRequest((previous) => (sameRequest(previous, next) ? previous : next)),
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [eligible, ready, choice, format, media, width]);

  // A page that stops being eligible (search filters re-render in place) drops its ad at once.
  const live = eligible ? request : null;

  useEffect(() => {
    const ins = insRef.current;
    if (!live || !ins) return;
    let settled = false;
    const settle = (filled: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      setOutcome({ of: live, filled });
    };
    const observer = new MutationObserver(() => {
      const status = ins.getAttribute("data-ad-status");
      if (status === "filled" || status === "unfilled") settle(status === "filled");
    });
    observer.observe(ins, { attributes: true, attributeFilter: ["data-ad-status"] });
    const timer = window.setTimeout(() => settle(false), AD_FILL_TIMEOUT_MS);
    loadAdsense(live.client, live.npa).then(
      () => settled || requestAd(),
      () => settle(false),
    );
    return () => {
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [live]);

  const current = outcome?.of === live ? outcome : null;
  const ad = live !== null && current?.filled !== false;
  const state = !ad ? "promo" : current?.filled ? "filled" : "pending";

  return (
    <aside
      ref={boxRef}
      data-ad-slot={placement}
      data-ad-state={state}
      data-ad-eligible={eligible || undefined}
      aria-label={ad ? labels.ad : labels.promoRegion}
      className={cn("relative flex flex-col overflow-hidden rounded-lg", ad ? "bg-surface-muted" : "bg-surface-brand", hide, className)}
      style={{ height: height + AD_LABEL_HEIGHT }}
    >
      <p className="px-3 text-xs text-foreground-muted" style={{ height: AD_LABEL_HEIGHT, lineHeight: `${AD_LABEL_HEIGHT}px` }}>
        {ad ? labels.ad : labels.promo}
      </p>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {ad ? (
          <ins
            // A new request (personalisation or mode changed) needs a fresh unit: AdSense fills an <ins> once.
            key={`${live.unit}:${live.npa}:${live.test}`}
            ref={insRef}
            className="adsbygoogle"
            style={{ display: "inline-block", width, height }}
            data-ad-client={live.client}
            data-ad-slot={live.unit}
            data-full-width-responsive="false"
            data-adtest={live.test ? "on" : undefined}
          />
        ) : (
          children
        )}
      </div>
    </aside>
  );
}
