import type { Metadata } from "next";
import { QUOTAS } from "@/config/quotas";
import { Badge } from "@/components/ui/badge";
import { readQuotas, type QuotaStatus } from "@/lib/quota";

// The free-quota board (§2), home of the signed-in back office. Moderation, reports and settings
// arrive with phase 5.

export const metadata: Metadata = { title: "Quotas" };

const LEVEL = {
  ok: { label: "Normal", variant: "success" },
  warning: { label: "Alerte", variant: "warning" },
  degraded: { label: "Mode dégradé", variant: "danger" },
  unknown: { label: "Inconnu", variant: "neutral" },
} as const;

const number = new Intl.NumberFormat("fr-FR");

function amount(status: QuotaStatus): string {
  const { unit } = QUOTAS[status.id];
  if (unit === "bytes") return `${(status.used / 1e9).toFixed(2)} / ${status.limit / 1e9} Go`;
  if (unit === "usd_micros") return `${(status.used / 1e6).toFixed(2)} / ${status.limit / 1e6} USD`;
  return `${number.format(status.used)} / ${number.format(status.limit)}`;
}

export default async function AdminHome() {
  const quotas = await readQuotas();
  return (
    <>
      <section className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Quotas gratuits</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Alerte à 70 %, mode dégradé au seuil indiqué. Les compteurs sont tenus par l&apos;application.
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="bg-surface-muted text-start text-foreground-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-start font-medium">Service</th>
                <th scope="col" className="px-4 py-2.5 text-start font-medium">Période</th>
                <th scope="col" className="px-4 py-2.5 text-end font-medium">Consommé</th>
                <th scope="col" className="px-4 py-2.5 text-start font-medium">État</th>
              </tr>
            </thead>
            <tbody>
              {quotas.map((status) => {
                const level = LEVEL[status.level];
                return (
                  <tr key={status.id} className="border-t border-border align-top">
                    <th scope="row" className="px-4 py-3 text-start font-normal">
                      <span className="block font-medium">{QUOTAS[status.id].service}</span>
                      <span className="block text-xs text-foreground-muted">{status.id}</span>
                    </th>
                    <td className="px-4 py-3 text-foreground-muted">{status.period}</td>
                    <td className="px-4 py-3 text-end tabular-nums">{amount(status)}</td>
                    <td className="px-4 py-3">
                      <Badge variant={level.variant}>{level.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
