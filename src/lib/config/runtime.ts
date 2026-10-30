import "server-only";
import { DEFAULT_ABUSE, resolveAbuseConfig, type AbuseConfig } from "@/config/abuse";
import { DEFAULT_FLAGS, resolveFlagsConfig, type FlagsConfig } from "@/config/flags";
import { DEFAULT_PRICING, resolvePricingConfig, type PricingConfig } from "@/config/pricing";
import { DEFAULT_SELLER_PAYMENTS, resolveSellerPaymentsConfig, type SellerPaymentsConfig } from "@/config/seller-payments";
import { alert } from "@/lib/alert";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { abuseRules, type AbuseRules } from "@/lib/moderation/abuse";
import { consume } from "@/lib/quota";

// Firestore `config/flags`, `config/pricing`, `config/sellerPayments` and `config/abuse` over their defaults, cached 5 minutes in memory
// (§5), same pattern as src/lib/legal/config.ts. Never throws: on an invalid document the
// resolver's fallback applies (flag by flag for the flags, the whole default pricing for the
// pricing) and a P1 alert goes out (once an hour: an invalid document silently reopening the Pro
// sign-up or discarding `salesEnabled` must be seen); on an unreachable Firestore the last known
// value (then the defaults).

const TTL_MS = 5 * 60 * 1000;

type CachedConfig<T> = (() => Promise<T>) & {
  /** Makes the next read go to Firestore (after a save from the back office); the copy stays the fallback of a failed read. */
  invalidate: () => void;
};

function cachedConfig<T>(docId: string, fallback: T, resolve: (stored: unknown) => { config: T; errors: string[] }): CachedConfig<T> {
  let cache: { value: T; expires: number } | undefined;
  const read = async () => {
    const now = Date.now();
    if (cache && cache.expires > now) return cache.value;
    try {
      if (!isFirestoreConfigured()) return fallback;
      const snapshot = await db().collection("config").doc(docId).get();
      void consume("firestore.reads", 1);
      const { config, errors } = resolve(snapshot.exists ? snapshot.data() : undefined);
      if (errors.length > 0) {
        logger.error({ errors }, `config/${docId} is invalid: fallback applies`);
        await alert({ severity: "P1", title: `Document config/${docId} invalide`, body: `Valeurs par défaut appliquées pour les champs en erreur :\n${errors.slice(0, 10).join("\n")}` }).catch(() => undefined);
      }
      cache = { value: config, expires: now + TTL_MS };
      return config;
    } catch (error) {
      logger.error({ err: error }, `config/${docId} unreachable: last known value applies`);
      return cache?.value ?? fallback;
    }
  };
  return Object.assign(read, {
    invalidate: () => {
      if (cache) cache.expires = 0;
    },
  });
}

export const getFlags: CachedConfig<FlagsConfig> = cachedConfig("flags", DEFAULT_FLAGS, resolveFlagsConfig);
export const getPricing: CachedConfig<PricingConfig> = cachedConfig("pricing", DEFAULT_PRICING, resolvePricingConfig);
export const getSellerPayments: CachedConfig<SellerPaymentsConfig> = cachedConfig("sellerPayments", DEFAULT_SELLER_PAYMENTS, resolveSellerPaymentsConfig);
/** Private anti-abuse values (spec §10): never sent to the browser, never committed. */
export const getAbuse: CachedConfig<AbuseConfig> = cachedConfig("abuse", DEFAULT_ABUSE, resolveAbuseConfig);

/** config/abuse compiled for the detectors (listing screen, prohibited lists, message keywords), once per cached value. */
export async function getAbuseRules(): Promise<AbuseRules> {
  return abuseRules(await getAbuse());
}
