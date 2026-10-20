import { FR_TIME_ZONE, MA_TIME_ZONE } from "@/config/tax";
import type { Period, ReceiptLine, SaleLine } from "./sales";

// Tax exports of the back office (phase 7 design §8), as CSV files a French spreadsheet opens as is:
// UTF-8 with BOM, `;` between cells, decimal comma, CRLF. Text cells that a spreadsheet would read
// as a formula are prefixed with an apostrophe. Superset of the fields the DGI guide may ask for,
// until it is read (research/fiscalite-legal.md); the owner's guide is docs/tax-runbook.md.

export const EXPORT_REPORTS = ["registre-dgi", "totaux-dgi", "urssaf", "e-reporting"] as const;
export type ExportReport = (typeof EXPORT_REPORTS)[number];

type Cell = string | number | null | undefined;
/** A number of minor units, printed with two decimals. */
const money = (minor: number) => ({ minor });
type Value = Cell | { minor: number };

function cell(value: Value): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const sign = value.minor < 0 ? "-" : "";
    const abs = Math.abs(Math.round(value.minor));
    return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
  }
  if (typeof value === "number") return String(value).replace(".", ",");
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly (readonly Value[])[]): string {
  return `﻿${rows.map((row) => row.map(cell).join(";")).join("\r\n")}\r\n`;
}

const dayIn = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const percent = (rate: number) => `${Math.round(rate * 10_000) / 100} %`;
const movement = (line: SaleLine) => (line.movement === "sale" ? "Vente" : "Remboursement");
const segment = (line: SaleLine) => (line.kind === "pack" ? "B2C" : "B2B");

/** DGI register: every Moroccan sale and refund of the quarter. */
export function dgiRegister(lines: readonly SaleLine[]): string {
  const rows: Value[][] = [["Date (Maroc)", "Horodatage UTC", "Mouvement", "Segment", "Service", "Référence", "Compte", "Client", "ICE", "Pays (indice)", "Devise", "Montant TTC", "Montant HT", "TVA", "Taux TVA"]];
  for (const line of lines.filter((candidate) => candidate.jurisdiction === "MA")) {
    rows.push([dayIn(line.at, MA_TIME_ZONE), line.at.toISOString(), movement(line), segment(line), line.description, line.reference, line.accountId, line.customerName, line.ice, line.country, line.currency, money(line.grossMinor), money(line.netMinor), money(line.vatMinor), percent(line.vatRate)]);
  }
  return toCsv(rows);
}

interface Totals {
  count: number;
  grossMinor: number;
  netMinor: number;
  vatMinor: number;
}

function add(map: Map<string, Totals>, key: string, line: SaleLine): void {
  const totals = map.get(key) ?? { count: 0, grossMinor: 0, netMinor: 0, vatMinor: 0 };
  totals.count += 1;
  totals.grossMinor += line.grossMinor;
  totals.netMinor += line.netMinor;
  totals.vatMinor += line.vatMinor;
  map.set(key, totals);
}

/** DGI quarterly totals: Moroccan turnover excluding VAT and the VAT, by segment, rate and currency. */
export function dgiTotals(lines: readonly SaleLine[], period: Period): string {
  const groups = new Map<string, Totals>();
  for (const line of lines) if (line.jurisdiction === "MA") add(groups, [segment(line), percent(line.vatRate), line.currency].join("|"), line);
  const rows: Value[][] = [["Période", "Segment", "Taux TVA", "Devise", "Opérations", "Chiffre d'affaires HT", "TVA", "Total TTC"]];
  const all: Totals = { count: 0, grossMinor: 0, netMinor: 0, vatMinor: 0 };
  for (const [key, totals] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [seg, rate, currency] = key.split("|");
    rows.push([period.label, seg, rate, currency, totals.count, money(totals.netMinor), money(totals.vatMinor), money(totals.grossMinor)]);
    if (currency === "MAD") for (const field of ["count", "grossMinor", "netMinor", "vatMinor"] as const) all[field] += totals[field];
  }
  rows.push([period.label, "Total MAD", "", "MAD", all.count, money(all.netMinor), money(all.vatMinor), money(all.grossMinor)]);
  return toCsv(rows);
}

/** E-reporting feed: turnover by day (Paris), segment, jurisdiction and VAT rate, every sale. */
export function eReporting(lines: readonly SaleLine[]): string {
  const groups = new Map<string, Totals>();
  for (const line of lines) add(groups, [dayIn(line.at, FR_TIME_ZONE), segment(line), line.jurisdiction, percent(line.vatRate), line.currency].join("|"), line);
  const rows: Value[][] = [["Date (Paris)", "Segment", "Pays de taxation", "Taux TVA", "Devise", "Opérations", "Montant HT", "TVA", "Montant TTC"]];
  for (const [key, totals] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [day, seg, jurisdiction, rate, currency] = key.split("|");
    rows.push([day, seg, jurisdiction, rate, currency, totals.count, money(totals.netMinor), money(totals.vatMinor), money(totals.grossMinor)]);
  }
  return toCsv(rows);
}

/**
 * URSSAF: the EUR received in the period (Stripe balance transactions: payments less refunds and
 * disputes), then the Moroccan VAT of the period's sales converted at the period's average rate,
 * and the turnover net of it (whether URSSAF wants that VAT left out is to be confirmed).
 */
export function urssaf(receipts: readonly ReceiptLine[], lines: readonly SaleLine[], period: Period): string {
  const rows: Value[][] = [["Date (Paris)", "Opération Stripe", "Catégorie", "Montant d'origine", "Devise d'origine", "Pays (indice)", "Taux de change", "Encaissé EUR", "Frais Stripe EUR", "Net EUR"]];
  let receivedMinor = 0;
  let feesMinor = 0;
  let madMinor = 0;
  let madEurMinor = 0;
  for (const receipt of receipts) {
    rows.push([dayIn(receipt.at, FR_TIME_ZONE), receipt.id, receipt.category, receipt.originalMinor === undefined ? null : money(receipt.originalMinor), receipt.originalCurrency, receipt.country, receipt.exchangeRate, money(receipt.amountEurMinor), money(-receipt.feeEurMinor), money(receipt.netEurMinor)]);
    receivedMinor += receipt.amountEurMinor;
    feesMinor += receipt.feeEurMinor;
    if (receipt.originalCurrency === "MAD" && receipt.originalMinor !== undefined) {
      madMinor += receipt.originalMinor;
      madEurMinor += receipt.amountEurMinor;
    }
  }
  const vatMadMinor = lines.filter((line) => line.jurisdiction === "MA" && line.currency === "MAD").reduce((sum, line) => sum + line.vatMinor, 0);
  const rate = madMinor !== 0 ? madEurMinor / madMinor : null;
  const vatEurMinor = rate === null ? 0 : Math.round(vatMadMinor * rate);
  rows.push([]);
  rows.push([`Total ${period.label}`, "", "Encaissé (paiements moins remboursements et litiges)", null, null, null, null, money(receivedMinor), money(-feesMinor), money(receivedMinor - feesMinor)]);
  rows.push([`Total ${period.label}`, "", "TVA marocaine des ventes (MAD)", money(vatMadMinor), "MAD", null, rate === null ? null : Math.round(rate * 1_000_000) / 1_000_000, money(vatEurMinor), null, null]);
  rows.push([`Total ${period.label}`, "", "Chiffre d'affaires net de TVA marocaine (à confirmer)", null, null, null, null, money(receivedMinor - vatEurMinor), null, null]);
  return toCsv(rows);
}
