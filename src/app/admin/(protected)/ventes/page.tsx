import type { Metadata } from "next";
import { EU_B2C_THRESHOLD_EUR, FRANCHISE_CEILING_EUR, THRESHOLD_ALERT_AT } from "@/config/tax";
import { Badge } from "@/components/ui/badge";
import { requirePageStaff } from "@/lib/auth/current-user";
import { getBillingThresholds } from "@/lib/payments/thresholds";
import { cn } from "@/lib/utils";
import { formatDateTime } from "../../_lib/moderation-format";
import { ExportForm } from "../../_components/export-form";

// Sales and tax (phase 7 design §8), admins only: the year's tax thresholds as the nightly job
// counted them, and the CSV exports for the DGI, URSSAF and the e-reporting.

export const metadata: Metadata = { title: "Ventes et fiscalité" };
export const dynamic = "force-dynamic";

const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

function Threshold({ label, usedMinor, limitEur, consequence }: { label: string; usedMinor: number | null; limitEur: number; consequence: string }) {
  const share = usedMinor === null ? null : usedMinor / (limitEur * 100);
  const level = share === null ? "unknown" : share >= 1 ? "reached" : share >= THRESHOLD_ALERT_AT ? "warning" : "ok";
  const badge = { ok: ["Sous le seuil", "success"], warning: ["Alerte", "warning"], reached: ["Seuil atteint", "danger"], unknown: ["Non mesuré", "neutral"] } as const;
  const value = share === null ? 0 : Math.min(100, Math.round(share * 100));
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{label}</h3>
        <Badge variant={badge[level][1]}>{badge[level][0]}</Badge>
      </div>
      <p className="text-2xl font-semibold tabular-nums">
        {usedMinor === null ? "—" : euros.format(usedMinor / 100)}
        <span className="text-base font-normal text-foreground-muted"> sur {euros.format(limitEur)}</span>
      </p>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className="relative h-2 rounded-full bg-surface-muted ring-1 ring-border ring-inset">
        <div className={cn("h-full rounded-full", level === "reached" ? "bg-danger" : level === "warning" ? "bg-primary" : "bg-structure/70")} style={{ width: `${value}%` }} />
        <div aria-hidden="true" className="absolute -top-1 h-4 w-0.5 rounded-full bg-featured" style={{ insetInlineStart: `calc(${THRESHOLD_ALERT_AT * 100}% - 1px)` }} />
      </div>
      <p className="text-sm text-foreground-muted text-pretty">{consequence}</p>
    </div>
  );
}

/** The last full month and quarter (UTC), the periods an export usually wants. */
function lastPeriods(now: Date): { lastMonth: string; lastQuarter: string } {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 - 3, 1));
  return {
    lastMonth: `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`,
    lastQuarter: `${quarterStart.getUTCFullYear()}-T${Math.floor(quarterStart.getUTCMonth() / 3) + 1}`,
  };
}

export default async function SalesPage() {
  await requirePageStaff(["admin"]);
  const now = new Date();
  const thresholds = await getBillingThresholds(now, true);
  const current = thresholds?.year === now.getUTCFullYear() ? thresholds : null;
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Ventes et fiscalité</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          {current ? `Seuils de ${current.year}, comptés le ${formatDateTime(current.computedAt.toISOString())}.` : "Seuils de l'année : pas encore comptés (tâche de nuit)."} La marche à
          suivre est dans le guide fiscal (docs/tax-runbook.md).
        </p>
      </div>
      <section aria-labelledby="thresholds-title" className="flex flex-col gap-3">
        <h2 id="thresholds-title" className="sr-only">
          Seuils de l&apos;année
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Threshold
            label="Ventes B2C dans l'Union européenne"
            usedMinor={current?.euB2cEurMinor ?? null}
            limitEur={EU_B2C_THRESHOLD_EUR}
            consequence="Au seuil, les packs en euros sont retirés de la vente jusqu'au 1er janvier, sauf inscription au guichet OSS."
          />
          <Threshold
            label="Franchise en base de TVA (encaissé)"
            usedMinor={current ? current.turnoverEurMinor : null}
            limitEur={FRANCHISE_CEILING_EUR}
            consequence="Au seuil, la franchise prend fin : la TVA française s'applique selon les règles du guide fiscal."
          />
        </div>
      </section>
      <ExportForm {...lastPeriods(now)} />
    </>
  );
}
