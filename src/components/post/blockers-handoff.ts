import type { FieldIssue } from "@/lib/contracts/listings";

// Blockers found outside the wizard (a renewal refused with 422 in "Mes annonces") handed to its
// review step, which lists them like those of a refused save. Per tab (sessionStorage) and read
// once; storage can be unavailable (private window, blocked site data): the step then shows only
// its own checks.

const MAX_ISSUES = 50;
const key = (listingId: string) => `joutiya:blockers:${listingId}`;

function isIssue(value: unknown): value is FieldIssue {
  if (!value || typeof value !== "object") return false;
  const issue = value as Record<string, unknown>;
  return typeof issue["path"] === "string" && typeof issue["code"] === "string" && (issue["message"] === undefined || typeof issue["message"] === "string");
}

export function stashBlockers(listingId: string, blockers: readonly FieldIssue[]): void {
  if (blockers.length === 0) return;
  try {
    sessionStorage.setItem(key(listingId), JSON.stringify(blockers.slice(0, MAX_ISSUES)));
  } catch {
    // Storage unavailable: the review step shows its own checks.
  }
}

/** The blockers handed for this listing, removed as they are read; [] when none (or unreadable). */
export function takeBlockers(listingId: string): FieldIssue[] {
  try {
    const raw = sessionStorage.getItem(key(listingId));
    if (raw === null) return [];
    sessionStorage.removeItem(key(listingId));
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isIssue).slice(0, MAX_ISSUES) : [];
  } catch {
    return [];
  }
}
