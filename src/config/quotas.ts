// Free-tier guards (§2 "Garde-fous de quotas"): every free quota has an app-side counter
// (valkey-queue, daily snapshot in Firestore quotaDaily), an alert at 70 % and a defined
// degraded mode at 100 %: never a silent outage, never a surprise bill.

export type QuotaPeriod = "day" | "month";

export interface QuotaDefinition {
  service: string;
  /** Free allowance per period, in `unit`. */
  limit: number;
  unit: "operations" | "requests" | "emails" | "events" | "bytes" | "usd_micros" | "neurons";
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
const MIB = 1024 * 1024;

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
    // A floor estimated by the nightly backup from its last complete rolling full
    // (src/lib/backup/export.ts). A gauge never resets: the period only scopes the stored value and
    // the alert markers, so the warning comes once a month, not every night.
    period: "month",
    resetTimeZone: "UTC",
    kind: "gauge",
    alertAt: 0.7,
    degradeAt: 1,
    // Alert only (src/lib/quota/gate.ts): the estimate is a floor, so it gates no route.
    degradedMode: "Alerte seulement, aucun blocage par le site (estimation plancher) : bascule vers l'offre Blaze à décider dès 700 Mo (§2) ; à 1 Go, Spark refuse les écritures.",
  },
  "resend.daily": {
    service: "Resend",
    // The account allows 100 a day, shared with the uptime Worker's alert relay: its RELAY_DAILY_CAP
    // (20, workers/uptime-probe/src/lib.ts) stays reserved, so the app counts against 80. Keep the
    // two constants in step (tests/unit/quota.test.ts checks their sum).
    limit: 80,
    unit: "emails",
    period: "day",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    // The last 10 % stay for security mails (src/lib/mail/deliver.ts).
    degradeAt: 0.9,
    degradedMode:
      'Seuls les e-mails de sécurité partent encore (Resend, puis Brevo) ; les e-mails transactionnels attendent la remise à zéro du lendemain dans la file "mail" ; les envois groupés (alertes de recherches) sont abandonnés.',
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
    degradedMode:
      'Seuls les e-mails de sécurité partent encore (Resend, puis Brevo) ; les e-mails transactionnels attendent le mois suivant dans la file "mail" ; alertes de recherches suspendues.',
  },
  "resend.bounces": {
    service: "Resend",
    // Permanent bounces reported by the webhook (src/lib/mail/webhook.ts), one per recipient. A
    // share of the ~80 daily mails: a handful already hurts the domain's reputation.
    limit: 10,
    unit: "emails",
    period: "day",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 1,
    degradedMode:
      "Pas de coupure automatique : vérifier les destinataires (inscriptions avec de fausses adresses ?) et la délivrabilité du domaine dans le tableau de bord Resend ; les adresses en rebond définitif ne reçoivent déjà plus que les e-mails de sécurité.",
  },
  "resend.complaints": {
    service: "Resend",
    // Spam complaints reported by the webhook, one per recipient: Resend pauses an account well below 1 %.
    limit: 3,
    unit: "emails",
    period: "day",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 1,
    degradedMode:
      "Pas de coupure automatique : vérifier le gabarit, la fréquence (alertes de recherches) et les destinataires des envois du jour ; les plaignants ne reçoivent déjà plus que les e-mails de sécurité.",
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
    degradedMode: 'E-mails de sécurité reportés au lendemain dans la file "mail" ; alerte P1 une fois par jour.',
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
    // Every read is essential (photo pipeline, one HEAD per nightly backup, staff photo review):
    // nothing to cut on the app side, and the usage stays far below the allowance.
    degradedMode: "Pas de coupure automatique (toutes les lectures servent le pipeline photo, la sauvegarde ou la modération) : vérifier l'origine des lectures dans le tableau de bord R2.",
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
  "valkey.queueMemory": {
    service: "Valkey (file de travaux)",
    // maxmemory of docker/valkey/queue.conf, measured by the worker heartbeat. noeviction: at 100 %
    // every write fails, quota counters included, so the alert comes early.
    limit: 192 * MIB,
    unit: "bytes",
    period: "day",
    resetTimeZone: "UTC",
    kind: "gauge",
    alertAt: 0.7,
    degradeAt: 0.9,
    degradedMode: "À 100 %, la file refuse toute écriture (travaux, compteurs de quotas) : purger les travaux terminés ou relever maxmemory.",
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
  "sentry.events": {
    service: "Sentry",
    // Errors of `web` and `worker`, counted in beforeSend (src/lib/observability/sentry-server.ts).
    // Browser events are not counted: no server hop, and the free plan refuses events above the
    // quota without billing.
    limit: 5_000,
    unit: "events",
    period: "month",
    resetTimeZone: "UTC",
    kind: "counter",
    alertAt: 0.7,
    degradeAt: 0.9,
    degradedMode:
      "Événements serveur abandonnés avant envoi jusqu'à la fin du mois (les journaux pino restent sur la VM) ; les événements navigateur ne sont pas comptés, Sentry les refuse au-delà du quota sans facturation.",
  },
} as const satisfies Record<string, QuotaDefinition>;

export type QuotaId = keyof typeof QUOTAS;
export const QUOTA_IDS = Object.keys(QUOTAS) as QuotaId[];
