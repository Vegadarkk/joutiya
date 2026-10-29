import type { RentalCheckView } from "@/lib/contracts/pro";
import { dayNumber, moroccoToday } from "@/lib/listings/rental-availability";
import type { RentalCheck, RentalCheckIssue } from "./profile-schema";

// Comparison of a car rental agency's licence decision with its declarations (decision 5). Claude
// only reads the document (rental-check.ts); this decides, deterministically: the decision's
// number must carry the digits of the declared reference, the beneficiary must be the shop (its
// verified ICE, else its name), the date must not be in the future, and no sign of editing may
// show. Anything else goes to a moderator with the reasons. Pure: the unit tests cover it.

/** Claude's confidence under which a consistent reading still goes to a moderator. */
export const RENTAL_CHECK_MIN_CONFIDENCE = 0.85;

/** What Claude read (empty strings when absent). */
export interface AgrementReading {
  isAgrementDecision: boolean;
  legible: boolean;
  companyName: string;
  ice: string;
  reference: string;
  decisionDate: string;
  tamperingSigns: string[];
  confidence: number;
}

export interface AgrementDeclaration {
  agrementRef: string;
  /** The shop's verified ICE (KYBC). */
  ice: string;
  /** The shop's name. */
  name: string;
}

/** Digit groups of a reference, leading zeros dropped: "AGR 0123/2025" and "N° 123-2025" both give ["123", "2025"]. */
export function referenceDigits(reference: string): string[] {
  return (reference.match(/\d+/g) ?? []).map((group) => group.replace(/^0+(?=\d)/, ""));
}

export function sameReference(declared: string, read: string): boolean {
  const a = referenceDigits(declared);
  const b = referenceDigits(read);
  return a.length > 0 && a.length === b.length && a.every((group, index) => group === b[index]);
}

/** Words of a legal form, ignored when names are compared ("Océan Rent SARL AU" = "STE OCEAN RENT"). */
const LEGAL_WORDS = new Set(["sarl", "sarlau", "au", "sa", "sas", "snc", "ste", "societe", "ets", "etablissement", "etablissements", "ei", "cooperative", "de", "la", "le", "les", "du", "des", "et"]);

export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !LEGAL_WORDS.has(word))
    .join("");
}

const digits = (value: string) => value.replace(/\D/g, "");

export function sameCompany(declaration: Pick<AgrementDeclaration, "ice" | "name">, reading: Pick<AgrementReading, "ice" | "companyName">): boolean {
  const ice = digits(reading.ice);
  if (ice.length === 15) return ice === digits(declaration.ice);
  const read = nameKey(reading.companyName);
  const declared = nameKey(declaration.name);
  if (read.length < 3 || declared.length < 3) return false;
  return read === declared || (Math.min(read.length, declared.length) >= 5 && (read.includes(declared) || declared.includes(read)));
}

/** A decision date that is not a real day, or after today in Morocco. Absent: no issue (old decisions may not show it legibly). */
export function badDecisionDate(date: string, now: Date): boolean {
  if (!date) return false;
  const day = dayNumber(date);
  return Number.isNaN(day) || day > moroccoToday(now);
}

export function agrementIssues(reading: AgrementReading, declaration: AgrementDeclaration, now: Date): RentalCheckIssue[] {
  if (!reading.isAgrementDecision) return ["not_agrement"];
  const issues: RentalCheckIssue[] = [];
  if (!reading.legible) issues.push("unreadable");
  if (!sameReference(declaration.agrementRef, reading.reference)) issues.push("reference");
  if (!sameCompany(declaration, reading)) issues.push("company");
  if (badDecisionDate(reading.decisionDate, now)) issues.push("date");
  if (reading.tamperingSigns.length > 0) issues.push("tampering");
  if (!(reading.confidence >= RENTAL_CHECK_MIN_CONFIDENCE)) issues.push("low_confidence");
  return issues;
}

/** The check as the agency sees it (GET /api/pro/me, POST /api/pro/me/rental/check). */
export function rentalCheckView(check: RentalCheck): RentalCheckView {
  return {
    status: check.status,
    submittedAt: check.submittedAt.toISOString(),
    checkedAt: check.checkedAt ? check.checkedAt.toISOString() : null,
    method: check.method ?? null,
    reason: check.status === "rejected" ? (check.reason ?? null) : null,
  };
}
