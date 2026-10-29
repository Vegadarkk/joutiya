import type { RentalCheckView } from "@/lib/contracts/pro";
import { dayNumber, moroccoToday } from "@/lib/listings/rental-availability";
import type { RentalCheck, RentalCheckIssue } from "./profile-schema";

// Comparison of a car rental agency's licence decision with its declarations (decision 5). Claude
// only reads the document (rental-check.ts); this decides, deterministically: the decision's
// number must carry the digits of the declared reference, no other shop may hold that reference
// verified, the beneficiary must be the shop by its verified ICE (a name alone, even identical,
// leaves it to a moderator: names are not unique), the date must not be in the future, and no sign
// of editing may show. Anything else goes to a moderator with the reasons. Pure: the unit tests
// cover it.

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
  /** Another shop holds a verified check of the same reference (referenceKey). */
  referenceTaken?: boolean;
}

/** Digit groups of a reference, leading zeros dropped: "AGR 0123/2025" and "N° 123-2025" both give ["123", "2025"]. */
export function referenceDigits(reference: string): string[] {
  return (reference.match(/\d+/g) ?? []).map((group) => group.replace(/^0+(?=\d)/, ""));
}

/** The reference as compared across shops: "AGR 0123/2025" -> "123-2025"; empty without digits. */
export function referenceKey(reference: string): string {
  return referenceDigits(reference).join("-");
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

/**
 * How the beneficiary matches the shop: "ice" when the document shows the shop's 15-digit ICE,
 * "name" when it shows no ICE but the same name (legal forms, accents and punctuation aside), null
 * otherwise. A different ICE never matches, a name merely containing the other one neither.
 */
export function companyMatch(declaration: Pick<AgrementDeclaration, "ice" | "name">, reading: Pick<AgrementReading, "ice" | "companyName">): "ice" | "name" | null {
  const ice = digits(reading.ice);
  if (ice.length === 15) return ice === digits(declaration.ice) ? "ice" : null;
  const read = nameKey(reading.companyName);
  return read.length >= 3 && read === nameKey(declaration.name) ? "name" : null;
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
  if (declaration.referenceTaken) issues.push("reference_taken");
  const company = companyMatch(declaration, reading);
  if (company === null) issues.push("company");
  else if (company === "name") issues.push("no_ice");
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
