"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, inputClassName } from "@/components/ui/input";
import { ADMIN_API } from "./api-client";

// Tax export download (phase 7 design §8): a report and its period, then a plain link to the CSV
// route, which the browser saves (admin only, audited server-side).

const REPORTS = [
  { id: "registre-dgi", label: "Registre DGI (ventes au Maroc, ligne à ligne)", period: "quarter" },
  { id: "totaux-dgi", label: "Totaux DGI du trimestre", period: "quarter" },
  { id: "urssaf", label: "URSSAF : chiffre d'affaires encaissé en euros", period: "month" },
  { id: "e-reporting", label: "E-reporting : ventes par jour et taux de TVA", period: "month" },
] as const;

const QUARTER = /^\d{4}-T[1-4]$/;
const MONTH_OR_QUARTER = /^\d{4}-(?:0[1-9]|1[0-2]|T[1-4])$/;

export function ExportForm({ lastMonth, lastQuarter }: { lastMonth: string; lastQuarter: string }) {
  const [report, setReport] = useState<(typeof REPORTS)[number]["id"]>("registre-dgi");
  const kind = REPORTS.find((item) => item.id === report)!.period;
  const [period, setPeriod] = useState(lastQuarter);
  const valid = (kind === "quarter" ? QUARTER : MONTH_OR_QUARTER).test(period);

  return (
    <form className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5" onSubmit={(event) => event.preventDefault()}>
      <div>
        <h2 className="text-lg font-semibold">Exports</h2>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Fichiers CSV pour le tableur (point-virgule, virgule décimale). Les dates de période sont en UTC. Chaque téléchargement est inscrit au
          journal d&apos;audit.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="Fichier">
          <select
            name="report"
            value={report}
            onChange={(event) => {
              const next = REPORTS.find((item) => item.id === event.target.value)!;
              setReport(next.id);
              setPeriod(next.period === "quarter" ? lastQuarter : lastMonth);
            }}
            className={inputClassName}
          >
            {REPORTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Période" hint={kind === "quarter" ? "Un trimestre, par exemple 2027-T1." : "Un mois (2027-03) ou un trimestre (2027-T1)."}>
          <Input name="period" autoComplete="off" spellCheck={false} maxLength={7} value={period} aria-invalid={!valid} onChange={(event) => setPeriod(event.target.value.trim().toUpperCase())} />
        </Field>
      </div>
      {valid ? (
        <Button asChild className="md:self-start">
          <a href={`${ADMIN_API.exports}/${report}?period=${encodeURIComponent(period)}`} download>
            <Download aria-hidden="true" />
            Télécharger le CSV
          </a>
        </Button>
      ) : (
        <p className="text-sm text-danger">Période à corriger.</p>
      )}
    </form>
  );
}
