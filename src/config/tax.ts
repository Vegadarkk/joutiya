// Tax figures of the sales exports and thresholds (phase 7 design §7, §8; research/fiscalite-legal.md).
// Rates and ceilings set by law, not by the owner: changing one is a code change with its source.

/** Moroccan VAT on digital services sold to Moroccan customers (art. 115 bis CGI Maroc), included in pack prices. */
export const MA_VAT_RATE = 0.2;

/** French VAT franchise for services (CGI art. 293 B, 2026): base ceiling, then the higher ceiling ending it at once. */
export const FRANCHISE_CEILING_EUR = 37_500;
export const FRANCHISE_HIGHER_CEILING_EUR = 41_250;

/**
 * EU cross-border B2C digital services per calendar year under which French VAT rules apply (no OSS):
 * at 100 % the EUR packs stop selling (design §8, deviation 7).
 */
export const EU_B2C_THRESHOLD_EUR = 10_000;

/** Share of a threshold that alerts the owner (quota-guard style). */
export const THRESHOLD_ALERT_AT = 0.7;

/** Time zone of the Moroccan register dates. */
export const MA_TIME_ZONE = "Africa/Casablanca";
