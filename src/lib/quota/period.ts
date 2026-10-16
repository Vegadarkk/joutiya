import type { QuotaDefinition } from "@/config/quotas";

export type QuotaLevel = "ok" | "warning" | "degraded";

/** Period bucket in the provider's reset time zone: "2026-10-13" (day) or "2026-10" (month). */
export function periodKey(definition: Pick<QuotaDefinition, "period" | "resetTimeZone">, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: definition.resetTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return definition.period === "day" ? `${get("year")}-${get("month")}-${get("day")}` : `${get("year")}-${get("month")}`;
}

export function classify(definition: Pick<QuotaDefinition, "limit" | "alertAt" | "degradeAt">, used: number): QuotaLevel {
  const ratio = used / definition.limit;
  if (ratio >= definition.degradeAt) return "degraded";
  if (ratio >= definition.alertAt) return "warning";
  return "ok";
}

/** Counter lifetime: long enough for the nightly report to read the closed period. */
export function retentionSeconds(definition: Pick<QuotaDefinition, "period">): number {
  return definition.period === "day" ? 40 * 86_400 : 400 * 86_400;
}

/**
 * First instant of the period after the one holding `at`: when the provider resets the counter.
 * Found by bisection on `periodKey` (DST-safe, 1 s precision, always at or after the boundary).
 */
export function nextPeriodStart(definition: Pick<QuotaDefinition, "period" | "resetTimeZone">, at: Date): Date {
  const current = periodKey(definition, at);
  let inside = at.getTime();
  let beyond = inside + (definition.period === "day" ? 2 : 33) * 86_400_000;
  while (beyond - inside > 1_000) {
    const middle = inside + Math.floor((beyond - inside) / 2);
    if (periodKey(definition, new Date(middle)) === current) inside = middle;
    else beyond = middle;
  }
  return new Date(beyond);
}
