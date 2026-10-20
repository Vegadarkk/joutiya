import type { Metadata } from "next";
import Link from "next/link";
import { REPORT_PRIORITIES } from "@/config/report-reasons";
import { Badge } from "@/components/ui/badge";
import { requirePageStaff } from "@/lib/auth/current-user";
import { moderationStats } from "@/lib/decisions/stats";
import { cn } from "@/lib/utils";
import { formatDateTime, PRIORITY_DELAY, PRIORITY_TONE } from "../../_lib/moderation-format";
import { linkClassName, Panel } from "../../_components/panel";

// Moderation figures (design D12, D24, AF §10 "SLA visibles"): open reports and overdue ones per
// priority, median time to decision over 30 days against the target delay, appeal reversals over
// 90 days. Computed by the server and cached 5 minutes.

export const metadata: Metadata = { title: "Statistiques de modération" };

const TARGET_HOURS = { P0: 1, P1: 24, P2: 72, P3: 168 } as const;

function hours(value: number | null): string {
  if (value === null) return "Aucune décision";
  if (value < 1) return `${Math.max(1, Math.round(value * 60))} min`;
  if (value < 48) return `${value.toFixed(1).replace(".", ",")} h`;
  return `${(value / 24).toFixed(1).replace(".", ",")} j`;
}

const number = new Intl.NumberFormat("fr-FR");

export default async function StatsPage() {
  await requirePageStaff(["moderator", "admin"]);
  const stats = await moderationStats();
  const { appeals } = stats;
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Délais de modération</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Calculé le {formatDateTime(stats.generatedAt)}, actualisé toutes les 5 minutes au plus.
          {stats.sampled ? " Délais médians estimés sur un échantillon des décisions récentes." : ""}
        </p>
      </div>

      <div role="region" aria-labelledby="sla-title" tabIndex={0} className="overflow-x-auto rounded-lg border border-border bg-surface">
        <h2 id="sla-title" className="sr-only">
          Signalements par priorité
        </h2>
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="bg-surface-muted text-foreground-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-start font-medium">Priorité</th>
              <th scope="col" className="px-4 py-2.5 text-end font-medium">Ouverts</th>
              <th scope="col" className="px-4 py-2.5 text-end font-medium">En retard</th>
              <th scope="col" className="px-4 py-2.5 text-end font-medium">Décidés sur 30 jours</th>
              <th scope="col" className="px-4 py-2.5 text-end font-medium">Délai médian</th>
              <th scope="col" className="px-4 py-2.5 text-end font-medium">Délai cible</th>
            </tr>
          </thead>
          <tbody>
            {REPORT_PRIORITIES.map((priority) => {
              const open = stats.open[priority];
              const decided = stats.decided30d[priority];
              const slow = decided.medianHours !== null && decided.medianHours > TARGET_HOURS[priority];
              return (
                <tr key={priority} className="border-t border-border">
                  <th scope="row" className="px-4 py-3 text-start font-normal">
                    <Link href={`/signalements?priorite=${priority}`} aria-label={`Signalements ${priority}`}>
                      <Badge variant={PRIORITY_TONE[priority]}>{priority}</Badge>
                    </Link>
                  </th>
                  <td className="px-4 py-3 text-end tabular-nums">{number.format(open.count)}</td>
                  <td className={cn("px-4 py-3 text-end tabular-nums", open.overdue > 0 && "font-semibold text-danger")}>{number.format(open.overdue)}</td>
                  <td className="px-4 py-3 text-end tabular-nums">{number.format(decided.count)}</td>
                  <td className={cn("px-4 py-3 text-end tabular-nums", slow && "font-semibold text-warning")}>{hours(decided.medianHours)}</td>
                  <td className="px-4 py-3 text-end text-foreground-muted">{PRIORITY_DELAY[priority]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="Recours" meta={<Link href="/recours" className={linkClassName}>Ouvrir la file</Link>}>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-foreground-muted">Ouverts</dt>
            <dd className="text-end tabular-nums">{number.format(appeals.open)}</dd>
            <dt className="text-foreground-muted">En retard (plus de 14 jours)</dt>
            <dd className={cn("text-end tabular-nums", appeals.overdue > 0 && "font-semibold text-danger")}>{number.format(appeals.overdue)}</dd>
            <dt className="text-foreground-muted">Décidés sur 90 jours</dt>
            <dd className="text-end tabular-nums">{number.format(appeals.decided90d)}</dd>
            <dt className="text-foreground-muted">Décisions annulées sur recours</dt>
            <dd className="text-end tabular-nums">
              {appeals.reversalRate === null ? "Aucun recours décidé" : `${number.format(appeals.reversed90d)} (${Math.round(appeals.reversalRate * 100)} %)`}
            </dd>
          </dl>
        </Panel>
        <Panel title="Autorités">
          <p className="text-sm">
            {stats.authorities.open === 0 ? "Aucune demande ouverte." : `${number.format(stats.authorities.open)} demande(s) ouverte(s).`}
          </p>
        </Panel>
      </div>
    </>
  );
}
