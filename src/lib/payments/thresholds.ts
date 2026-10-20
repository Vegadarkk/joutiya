import "server-only";
import { EU_B2C_THRESHOLD_EUR, FRANCHISE_CEILING_EUR, THRESHOLD_ALERT_AT } from "@/config/tax";
import { alert } from "@/lib/alert";
import { listOrdersOfJurisdictionBetween } from "@/lib/db/repositories/billing";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { z } from "@/lib/zod";
import { receiptsOf } from "./sales";
import { isStripeConfigured, stripeRequest } from "./stripe-api";

// Yearly tax thresholds (phase 7 design §8), counted each night like a free quota: EU B2C sales
// (EUR packs) against the 10,000 EUR under which no OSS is needed, and every EUR received against
// the French franchise ceiling (whether sales outside France count is unconfirmed: all are
// counted). Each counter alerts once per level and calendar year (70 %, then 100 %). At 100 % of
// the EU counter the EUR packs leave the grid and their checkout is refused until 1 January.
// State in system/billingThresholds.

const DOC = "billingThresholds";
const CACHE_MS = 5 * 60_000;
const LEVELS = [THRESHOLD_ALERT_AT, 1] as const;

const thresholdsSchema = z
  .object({
    year: z.number().int(),
    euB2cEurMinor: z.number().int(),
    /** Null while Stripe is not configured. */
    turnoverEurMinor: z.number().int().nullable(),
    /** Highest level already alerted this year, per counter. */
    alerted: z.object({ euB2c: z.number(), franchise: z.number() }).strict(),
    computedAt: z.date(),
  })
  .strict();
export type BillingThresholds = z.infer<typeof thresholdsSchema>;

const ref = () => db().collection(COLLECTIONS.system).doc(DOC);
let cache: { value: BillingThresholds | null; at: number } | undefined;

export function resetThresholdsCache(): void {
  cache = undefined;
}

export async function getBillingThresholds(now = new Date(), fresh = false): Promise<BillingThresholds | null> {
  if (!fresh && cache && now.getTime() - cache.at < CACHE_MS) return cache.value;
  const snapshot = await ref().get();
  void consume("firestore.reads", 1);
  const data = snapshot.data();
  const parsed = data ? thresholdsSchema.safeParse({ ...data, computedAt: data.computedAt?.toDate?.() }) : null;
  cache = { value: parsed?.success ? parsed.data : null, at: now.getTime() };
  return cache.value;
}

/** False once this year's EU B2C sales reach the threshold: the EUR packs are not sold any more. */
export function euPacksOpen(thresholds: BillingThresholds | null, now = new Date()): boolean {
  return !thresholds || thresholds.year !== now.getUTCFullYear() || thresholds.euB2cEurMinor < EU_B2C_THRESHOLD_EUR * 100;
}

const euros = (minor: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(minor / 100);

async function alertLevel(name: string, usedMinor: number, limitEur: number, before: number, consequence: string): Promise<number> {
  const share = usedMinor / (limitEur * 100);
  const level = [...LEVELS].reverse().find((candidate) => share >= candidate) ?? 0;
  if (level <= before) return before;
  await alert({
    severity: level >= 1 ? "P1" : "P2",
    title: `${name} : ${Math.floor(share * 100)} % du seuil annuel`,
    body: `${euros(usedMinor)} sur ${euros(limitEur * 100)} depuis le 1er janvier. ${level >= 1 ? consequence : "Préparer la suite (docs/tax-runbook.md)."}`,
  });
  return level;
}

/** Recounts the year to date, stores it and alerts the levels newly reached. */
export async function updateBillingThresholds(now = new Date(), stripe: typeof stripeRequest | null = isStripeConfigured() ? stripeRequest : null): Promise<BillingThresholds> {
  const year = now.getUTCFullYear();
  const from = new Date(Date.UTC(year, 0, 1));
  const orders = await listOrdersOfJurisdictionBetween("EU", from, new Date(Date.UTC(year + 1, 0, 1)));
  // A refunded pack is not a sale; an EU pack is priced in EUR.
  const euB2cEurMinor = orders.filter((order) => order.status === "paid" && order.currency === "EUR").reduce((sum, order) => sum + (order.amountMinor ?? 0), 0);
  const turnoverEurMinor = stripe ? (await receiptsOf({ label: String(year), from, to: now }, stripe)).reduce((sum, receipt) => sum + receipt.amountEurMinor, 0) : null;

  const previous = await getBillingThresholds(now, true).catch(() => null);
  const alerted = previous?.year === year ? previous.alerted : { euB2c: 0, franchise: 0 };
  const next: BillingThresholds = {
    year,
    euB2cEurMinor,
    turnoverEurMinor,
    alerted: {
      euB2c: await alertLevel("Ventes B2C dans l'UE", euB2cEurMinor, EU_B2C_THRESHOLD_EUR, alerted.euB2c, "Les packs en euros sont retirés de la vente jusqu'au 1er janvier, sauf inscription au guichet OSS."),
      franchise: turnoverEurMinor === null ? alerted.franchise : await alertLevel("Franchise en base de TVA", turnoverEurMinor, FRANCHISE_CEILING_EUR, alerted.franchise, "La franchise prend fin : voir docs/tax-runbook.md avec le comptable."),
    },
    computedAt: now,
  };
  await ref().set(next);
  void consume("firestore.writes", 1);
  cache = { value: next, at: now.getTime() };
  logger.info({ year, euB2cEurMinor, turnoverEurMinor }, "billing thresholds updated");
  return next;
}
