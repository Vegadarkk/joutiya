import type { AdFormat } from "@/config/ads";
import type { PublicAdsConfig, PublicConfig } from "@/lib/config/public-types";
import type { ConsentChoice } from "@/lib/consent/cookie";
import { isEeaUkCh } from "@/lib/consent/region";

// Whether an eligible slot may ask AdSense for an ad (phase 6, D4, D5). Client-safe and pure. The
// page's eligibility (D6) is decided on the server; this adds the visitor side.

export interface AdRequest {
  client: string;
  unit: string;
  /** Test mode: `data-adtest="on"`, no paid impressions. */
  test: boolean;
  /** `requestNonPersonalizedAds`; undefined when Google's consent message decides (EEA/UK/CH). */
  npa: 0 | 1 | undefined;
}

export interface AdVisitor {
  ads: PublicAdsConfig;
  env: PublicConfig["env"];
  choice: ConsentChoice | null;
  /** Cloudflare country, null when unknown (treated as EEA/UK/CH). */
  country: string | null;
}

/** True when a visitor could get an ad at all: worth fetching the region for. */
export function adsConfigured(ads: PublicAdsConfig, env: PublicConfig["env"]): boolean {
  if (!ads.client || ads.mode === "off") return false;
  return ads.mode === "test" || env === "prod";
}

/**
 * The ad request of a slot, or null for the house promotion. Live ads run only in production.
 * EEA/UK/CH visitors get ads only once Google's certified consent message covers them
 * (`cmpEea`); everyone else needs `ads` accepted in our banner, and a refusal sends no request.
 */
export function adRequest(format: AdFormat, { ads, env, choice, country }: AdVisitor): AdRequest | null {
  const unit = ads.units[format];
  if (!unit || !ads.client || !adsConfigured(ads, env)) return null;
  const test = ads.mode === "test";
  if (isEeaUkCh(country)) return ads.cmpEea ? { client: ads.client, unit, test, npa: undefined } : null;
  if (!choice?.ads) return null;
  return { client: ads.client, unit, test, npa: choice.perso ? 0 : 1 };
}
