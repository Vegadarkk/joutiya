import { describe, expect, it } from "vitest";
import { dgiRegister, dgiTotals, eReporting, toCsv, urssaf } from "@/lib/payments/exports";
import { parsePeriod, splitIncluded, type ReceiptLine, type SaleLine } from "@/lib/payments/sales";
import { euPacksOpen, type BillingThresholds } from "@/lib/payments/thresholds";

// Tax exports (phase 7 design §8): periods, the VAT split of an inclusive price, the CSV a French
// spreadsheet opens (formula cells neutralised), the DGI register and totals, the e-reporting
// feed, URSSAF's EUR received net of Moroccan VAT, and the EU threshold that closes EUR packs.

const rows = (csv: string) =>
  csv
    .replace(/^﻿/, "")
    .trimEnd()
    .split("\r\n")
    .map((row) => row.split(";"));

const line = (extra: Partial<SaleLine>): SaleLine => ({
  at: new Date("2027-01-20T12:00:00Z"),
  kind: "pack",
  movement: "sale",
  reference: "txn_1",
  accountId: "uid1",
  country: "MA",
  jurisdiction: "MA",
  currency: "MAD",
  grossMinor: 10_000,
  ...splitIncluded(10_000, 0.2),
  vatRate: 0.2,
  description: "Pack de 110 crédits",
  ...extra,
});

describe("periods and VAT", () => {
  it("reads months, quarters (Q or T) and years in UTC", () => {
    expect(parsePeriod("2027-03")).toEqual({ label: "2027-03", from: new Date("2027-03-01T00:00:00Z"), to: new Date("2027-04-01T00:00:00Z") });
    expect(parsePeriod("2027-Q4")).toEqual({ label: "2027-T4", from: new Date("2027-10-01T00:00:00Z"), to: new Date("2028-01-01T00:00:00Z") });
    expect(parsePeriod("2027-T1")?.to).toEqual(new Date("2027-04-01T00:00:00Z"));
    expect(parsePeriod("2027")?.to).toEqual(new Date("2028-01-01T00:00:00Z"));
    for (const bad of ["2027-13", "2027-T5", "27-01", "2027-1", ""]) expect(parsePeriod(bad)).toBeNull();
  });

  it("bounds a period at midnight in the report's time zone, summer time included", () => {
    expect(parsePeriod("2027-04", "Europe/Paris")).toEqual({ label: "2027-04", from: new Date("2027-03-31T22:00:00Z"), to: new Date("2027-04-30T22:00:00Z") });
    expect(parsePeriod("2027-T1", "Europe/Paris")).toEqual({ label: "2027-T1", from: new Date("2026-12-31T23:00:00Z"), to: new Date("2027-03-31T22:00:00Z") });
    expect(parsePeriod("2027-11", "Europe/Paris")?.from).toEqual(new Date("2027-10-31T23:00:00Z"));
  });

  it("splits a VAT-inclusive price, rounding the VAT", () => {
    expect(splitIncluded(10_000, 0.2)).toEqual({ netMinor: 8_333, vatMinor: 1_667 });
    expect(splitIncluded(5_000, 0.2)).toEqual({ netMinor: 4_167, vatMinor: 833 });
    expect(splitIncluded(1_000, 0)).toEqual({ netMinor: 1_000, vatMinor: 0 });
  });
});

describe("CSV", () => {
  it("writes a BOM, semicolons, decimal commas and CRLF, quotes what needs it and neutralises formulas", () => {
    const csv = toCsv([["a", 1.5, null, { minor: -12_345 } as never], ["=HYPERLINK(\"x\")", "x;y", "-1", "@me"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe('﻿a;1,5;;-123,45\r\n"\'=HYPERLINK(""x"")";"x;y";\'-1;\'@me\r\n');
  });
});

describe("reports", () => {
  const period = parsePeriod("2027-T1")!;
  const sales = [
    line({}),
    line({ reference: "txn_2", movement: "refund", grossMinor: -5_000, netMinor: -4_167, vatMinor: -833, at: new Date("2027-03-01T10:00:00Z") }),
    line({ reference: "txn_eu", jurisdiction: "EU", country: "FR", currency: "EUR", grossMinor: 1_000, netMinor: 1_000, vatMinor: 0, vatRate: 0 }),
    line({ kind: "plan", reference: "JOUT-0001", accountId: "pro_abc", customerName: "Atlas Auto", ice: "001234567000089", grossMinor: 59_000, netMinor: 59_000, vatMinor: 0, vatRate: 0, description: "Business" }),
  ];

  it("lists the Moroccan sales and refunds in the DGI register, dated in Morocco and in UTC", () => {
    const table = rows(dgiRegister(sales));
    expect(table[0]).toContain("Montant HT");
    expect(table.slice(1).map((row) => row[5])).toEqual(["txn_1", "txn_2", "JOUT-0001"]);
    expect(table[1]!.slice(0, 4)).toEqual(["2027-01-20", "2027-01-20T12:00:00.000Z", "Vente", "B2C"]);
    expect(table[1]!.slice(11)).toEqual(["100,00", "83,33", "16,67", "20 %"]);
    expect(table[2]!.slice(2, 3).concat(table[2]!.slice(11, 14))).toEqual(["Remboursement", "-50,00", "-41,67", "-8,33"]);
    expect(table[3]!.slice(7, 9)).toEqual(["Atlas Auto", "001234567000089"]);
  });

  it("totals the quarter by segment and rate, then in MAD", () => {
    const table = rows(dgiTotals(sales, period));
    expect(table.slice(1)).toEqual([
      ["2027-T1", "B2B", "0 %", "MAD", "1", "590,00", "0,00", "590,00"],
      ["2027-T1", "B2C", "20 %", "MAD", "2", "41,66", "8,34", "50,00"],
      ["2027-T1", "Total MAD", "", "MAD", "3", "631,66", "8,34", "640,00"],
    ]);
  });

  it("groups every sale by Paris day, segment, country of taxation and rate for the e-reporting", () => {
    const table = rows(eReporting(sales));
    expect(table.slice(1).map((row) => row.slice(0, 6))).toEqual([
      ["2027-01-20", "B2B", "MA", "0 %", "MAD", "1"],
      ["2027-01-20", "B2C", "EU", "0 %", "EUR", "1"],
      ["2027-01-20", "B2C", "MA", "20 %", "MAD", "1"],
      ["2027-03-01", "B2C", "MA", "20 %", "MAD", "1"],
    ]);
  });

  it("sums the EUR received and takes the Moroccan VAT out at the period's average rate", () => {
    const receipts: ReceiptLine[] = [
      { id: "txn_A", at: new Date("2027-02-10T12:00:00Z"), category: "charge", amountEurMinor: 920, feeEurMinor: 76, netEurMinor: 844, exchangeRate: 0.092, originalMinor: 10_000, originalCurrency: "MAD", country: "MA" },
      { id: "txn_B", at: new Date("2027-03-01T10:00:00Z"), category: "refund", amountEurMinor: -460, feeEurMinor: 0, netEurMinor: -460, exchangeRate: 0.092, originalMinor: -5_000, originalCurrency: "MAD" },
      { id: "txn_C", at: new Date("2027-02-11T09:00:00Z"), category: "charge", amountEurMinor: 1_000, feeEurMinor: 40, netEurMinor: 960, exchangeRate: null },
    ];
    const table = rows(urssaf(receipts, sales, period));
    expect(table[1]).toEqual(["2027-02-10", "txn_A", "charge", "100,00", "MAD", "MA", "0,092", "9,20", "-0,76", "8,44"]);
    const totals = table.slice(-3);
    expect(totals[0]!.slice(7)).toEqual(["14,60", "-1,16", "13,44"]);
    // VAT of the Moroccan MAD sales: 16,67 - 8,33 = 8,34 MAD, at 460 EUR cents per 5,000 MAD cents.
    expect(totals[1]!.slice(3, 8)).toEqual(["8,34", "MAD", "", "0,092", "0,77"]);
    expect(totals[2]![7]).toBe("13,83");
  });
});

describe("EU threshold", () => {
  const at = new Date("2027-06-01T00:00:00Z");
  const counted = (euB2cEurMinor: number, year = 2027, previousYearEuB2cEurMinor = 0): BillingThresholds => ({
    year,
    euB2cEurMinor,
    previousYearEuB2cEurMinor,
    turnoverEurMinor: null,
    turnoverMonths: {},
    alerted: { euB2c: 0, franchise: 0 },
    computedAt: at,
  });

  it("closes the EUR packs once this year's or last year's EU B2C sales reach 10,000 EUR", () => {
    expect(euPacksOpen(null, at)).toBe(true);
    expect(euPacksOpen(counted(999_999), at)).toBe(true);
    expect(euPacksOpen(counted(1_000_000), at)).toBe(false);
    expect(euPacksOpen(counted(0, 2027, 1_000_000), at)).toBe(false);
    // On 1 January, before the night's count: last year's figure is the previous year's.
    expect(euPacksOpen(counted(1_000_000, 2026), at)).toBe(false);
    expect(euPacksOpen(counted(999_999, 2026, 1_000_000), at)).toBe(true);
    expect(euPacksOpen(counted(1_000_000, 2025), at)).toBe(true);
  });
});
