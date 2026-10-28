import "server-only";
import { EU_B2C_THRESHOLD_EUR, FRANCHISE_CEILING_EUR, FR_TIME_ZONE, THRESHOLD_ALERT_AT } from "@/config/tax";
import { alert } from "@/lib/alert";
import { getPricing } from "@/lib/config/runtime";
import { listOrdersOfJurisdictionBetween, type OrderRecord } from "@/lib/db/repositories/billing";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { z } from "@/lib/zod";
import { orderGrossMinor, parsePeriod, receiptsOf } from "./sales";
import { isStripeConfigured, stripeRequest } from "./stripe-api";

// Yearly tax thresholds (phase 7 design §8), counted each night like a free quota: EU B2C sales
// (EUR packs) against the 10,000 EUR under which no OSS is needed, and every EUR received against
// the French franchise ceiling (whether sales outside France count is unconfirmed: all are
// counted). Each counter alerts once per level and calendar year (70 %, then 100 %). The EU rule
// holds only below the threshold in the current AND the previous year: once a year reaches it,
// the EUR packs leave the grid and their checkout is refused until the end of the following year.
// The EUR received are summed by month (French time); a month is read again only while it may
// still change, and a Stripe failure keeps the months already counted. State in
// system/billingThresholds.

const DOC = "billingThresholds";
const CACHE_MS = 5 * 60_000;
const LEVELS = [THRESHOLD_ALERT_AT, 1] as const;
const EU_LIMIT_MINOR = EU_B2C_THRESHOLD_EUR * 100;

const thresholdsSchema = z
  .object({
    year: z.number().int(),
    euB2cEurMinor: z.number().int(),
    /** The previous calendar year's EU B2C sales, counted once in the year. */
    previousYearEuB2cEurMinor: z.number().int().default(0),
    /** Null while Stripe is not configured. */
    turnoverEurMinor: z.number().int().nullable(),
    /** EUR received by month of the year ("01"-"12"). */
    turnoverMonths: z.record(z.string().regex(/^(0[1-9]|1[0-2])$/), z.number().int()).default({}),
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

/** False while this year's or last year's EU B2C sales reached the threshold: the EUR packs are not sold. */
export function euPacksOpen(thresholds: BillingThresholds | null, now = new Date()): boolean {
  if (!thresholds) return true;
  const year = now.getUTCFullYear();
  if (thresholds.year === year) return thresholds.euB2cEurMinor < EU_LIMIT_MINOR && thresholds.previousYearEuB2cEurMinor < EU_LIMIT_MINOR;
  // Not counted yet this year: the stored year is the previous one.
  if (thresholds.year === year - 1) return thresholds.euB2cEurMinor < EU_LIMIT_MINOR;
  return true;
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

/** EU B2C sales of `year`: the EUR packs paid (a refunded pack is not a sale), at the price paid. */
async function euB2cOf(year: number): Promise<number> {
  const [orders, pricing] = await Promise.all([listOrdersOfJurisdictionBetween("EU", new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1))), getPricing()]);
  const sales = (order: OrderRecord) => order.status === "paid" && order.currency === "EUR";
  return orders.filter(sales).reduce((sum, order) => sum + orderGrossMinor(order, pricing), 0);
}

/** The year's EUR received by month: the current and previous months read again, the others once. */
async function turnoverMonthsOf(year: number, now: Date, known: Record<string, number>, stripe: typeof stripeRequest): Promise<Record<string, number>> {
  const months = { ...known };
  const current = now.getUTCMonth();
  for (let month = 0; month <= current; month += 1) {
    const key = String(month + 1).padStart(2, "0");
    if (key in months && month < current - 1) continue;
    try {
      const receipts = await receiptsOf(parsePeriod(`${year}-${key}`, FR_TIME_ZONE)!, stripe);
      months[key] = receipts.reduce((sum, receipt) => sum + receipt.amountEurMinor, 0);
    } catch (error) {
      // The EU counter goes on; the month is read again next night.
      logger.error({ err: error, year, month: key }, "billing thresholds: EUR received not read");
    }
  }
  return months;
}

/** Recounts the year to date, stores it and alerts the levels newly reached. */
export async function updateBillingThresholds(now = new Date(), stripe: typeof stripeRequest | null = isStripeConfigured() ? stripeRequest : null): Promise<BillingThresholds> {
  const year = now.getUTCFullYear();
  const previous = await getBillingThresholds(now, true).catch(() => null);
  const sameYear = previous?.year === year;
  const [euB2cEurMinor, previousYearEuB2cEurMinor] = await Promise.all([euB2cOf(year), sameYear ? previous.previousYearEuB2cEurMinor : euB2cOf(year - 1)]);
  const turnoverMonths = stripe ? await turnoverMonthsOf(year, now, sameYear ? previous.turnoverMonths : {}, stripe) : sameYear ? previous.turnoverMonths : {};
  const turnoverEurMinor = stripe || Object.keys(turnoverMonths).length > 0 ? Object.values(turnoverMonths).reduce((sum, value) => sum + value, 0) : null;

  const alerted = sameYear ? previous.alerted : { euB2c: 0, franchise: 0 };
  const next: BillingThresholds = {
    year,
    euB2cEurMinor,
    previousYearEuB2cEurMinor,
    turnoverEurMinor,
    turnoverMonths,
    alerted: {
      euB2c: await alertLevel("Ventes B2C dans l'UE", euB2cEurMinor, EU_B2C_THRESHOLD_EUR, alerted.euB2c, "Les packs en euros sont retirés de la vente jusqu'à la fin de l'année prochaine, sauf inscription au guichet OSS."),
      franchise: turnoverEurMinor === null ? alerted.franchise : await alertLevel("Franchise en base de TVA", turnoverEurMinor, FRANCHISE_CEILING_EUR, alerted.franchise, "La franchise prend fin : voir docs/tax-runbook.md avec le comptable."),
    },
    computedAt: now,
  };
  await ref().set(next);
  void consume("firestore.writes", 1);
  cache = { value: next, at: now.getTime() };
  logger.info({ year, euB2cEurMinor, previousYearEuB2cEurMinor, turnoverEurMinor }, "billing thresholds updated");
  return next;
}
