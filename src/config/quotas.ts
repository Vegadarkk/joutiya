// Free-tier guards (§2 "Garde-fous de quotas"): every free quota has an app-side counter
// (valkey-queue, daily snapshot in Firestore quotaDaily), an alert at 70 % and a defined
// degraded mode at 100 %: never a silent outage, never a surprise bill.

export type QuotaPeriod = "day" | "month";

export interface QuotaDefinition {
  service: string;
  /** Free allowance per period, in `unit`. */
  limit: number;
  unit: "operations" | "requests" | "emails" | "bytes" | "usd_micros" | "neurons";
  period: QuotaPeriod;
  /** Time zone of the provider's reset (Firestore resets at midnight Pacific time). */
  resetTimeZone: string;
  /** "counter": incremented by usage. "gauge": set to a measured value (stored bytes). */
  kind: "counter" | "gauge";
  /** Share of the limit that triggers the warning alert. */
  alertAt: number;
  /** Share of the limit where the degraded mode starts. */
  degradeAt: number;
  /** What the app does from `degradeAt` (French: shown in alerts and the back office). */
  degradedMode: string;
}

const GB = 1_000_000_000;

/**
 * Internal Claude budget per month, in micro-USD (§7, §9 "budget interne réduit en staging"): the
 * 5 USD Console cap is shared by the organisation, so only production gets it; staging and dev
 * stop at 1 USD. One image serves staging and production: APP_ENV is read at runtime.
 */
export function claudeBudgetMicroUsd(appEnv: string | undefined): number {
  return appEnv === "prod" ? 5_000_000 : 1_000_000;
}

export const QUOTAS = {
  "firestore.reads": {
    service: "Firestore (Spark)",
    limit: 50_000,
    unit: "operations",
    period: "day",
    resetTimeZone: "America/Los_Angeles",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 1,
    degradedMode: "Cartes de résultats servies par Meilisearch seulement ; pages annonce depuis le cache ISR ; écritures non essentielles reportées.",
  },
  "firestore.writes": {
    service: "Firestore (Spark)",
    limit: 20_000,
    unit: "operations",
    period: "day",
    resetTimeZone: "America/Los_Angeles",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 1,
    degradedMode: "Dépôt d'annonces et messagerie suspendus avec un message clair jusqu'à la remise à zéro ; signalements toujours acceptés.",
  },
  "firestore.deletes": {
    service: "Firestore (Spark)",
    limit: 20_000,
    unit: "operations",
    period: "day",
    resetTimeZone: "America/Los_Angeles",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 1,
    degradedMode: "Purges reportées au lendemain.",
  },
  "firestore.storage": {
    service: "Firestore (Spark)",
    limit: 1 * GB,
    unit: "bytes",
    period: "day",
    resetTimeZone: "UTC",
    kind: "gauge",
    alertAt: 0.7,
    degradeAt: 1,
    degradedMode: "Bascule vers l'offre Blaze à décider (seuil de 700 Mo, §2) ; dépôt suspendu à 100 %.",
  },
  "resend.daily": {
    service: "Resend",
    limit: 100,
    unit: "emails",
    period: "day",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    // The last 10 % stay for security mails (src/lib/mail/deliver.ts).
    degradeAt: 0.9,
    degradedMode: "Seuls les e-mails de sécurité partent encore (Resend, puis Brevo) ; les autres attendent le lendemain.",
  },
  "resend.monthly": {
    service: "Resend",
    limit: 3_000,
    unit: "emails",
    period: "month",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 0.9,
    degradedMode: "Seuls les e-mails de sécurité partent encore (Resend, puis Brevo) ; alertes de recherches suspendues.",
  },
  "brevo.daily": {
    service: "Brevo",
    limit: 300,
    unit: "emails",
    period: "day",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 1,
    degradedMode: "E-mails de sécurité reportés au lendemain ; alerte P0.",
  },
  "r2.storage": {
    service: "Cloudflare R2",
    limit: 10 * GB,
    unit: "bytes",
    period: "day",
    resetTimeZone: "UTC",
    kind: "gauge",
    // Alert at 8 GB (§2), before any paid usage.
    alertAt: 0.8,
    degradeAt: 0.95,
    degradedMode: "Nouveaux envois de photos suspendus ; annonces sans nouvelle photo.",
  },
  "r2.classA": {
    service: "Cloudflare R2",
    limit: 1_000_000,
    unit: "operations",
    period: "month",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 0.95,
    degradedMode: "Nouveaux envois de photos suspendus jusqu'au mois suivant.",
  },
  "r2.classB": {
    service: "Cloudflare R2",
    limit: 10_000_000,
    unit: "operations",
    period: "month",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 0.95,
    degradedMode: "Lectures du worker limitées aux traitements essentiels.",
  },
  "claude.budget": {
    service: "Claude API",
    // 5 USD hard cap in the Console; internal switch at 80 % (4 USD in prod, 0.80 USD elsewhere, Z4).
    limit: claudeBudgetMicroUsd(process.env.APP_ENV),
    unit: "usd_micros",
    period: "month",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 0.8,
    degradedMode: "Bascule sur le secours gratuit (Workers AI, modération OpenAI), puis votre seule file.",
  },
  "workersAi.neurons": {
    service: "Cloudflare Workers AI",
    limit: 10_000,
    unit: "neurons",
    period: "day",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 1,
    degradedMode: "Modération OpenAI seule, puis votre file.",
  },
} as const satisfies Record<string, QuotaDefinition>;

export type QuotaId = keyof typeof QUOTAS;
export const QUOTA_IDS = Object.keys(QUOTAS) as QuotaId[];
