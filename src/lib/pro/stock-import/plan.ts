import { isDeepStrictEqual } from "node:util";
import { criterionApplies, subcategoryById } from "@/config/categories";
import type { ListingAttributes, ListingPatch, ListingStatus } from "@/lib/contracts/listings";
import { STOCK_WARNING_CODES, type StockListing, type StockRowResult } from "@/lib/contracts/stock-import";
import type { RentalPeriod } from "@/lib/listings/rental-availability";
import { refKey, type ImportedFields, type ParsedRow } from "./rows";

// What an import does with each line (design concession/concession.md §4), pure: a reference seen
// for the first time becomes a draft (within the shop's remaining slots), a known one updates its
// listing with the fields that changed, a line identical to its listing does nothing. Duplicate
// references and lines with errors are refused; a listing that can no longer be edited (sold,
// removed) is reported. Published or paused listings missing from the file are listed as
// "absent": the dealer may mark them sold, never automatically. A car rental's blocked periods are
// not a listing field: they change through the availability service, after the fields.

/** Statuses a stock line may update (the listing service's EDITABLE_STATUSES). */
export const UPDATABLE_STATUSES: readonly ListingStatus[] = ["draft", "pending_review", "published", "paused", "expired", "rejected"];
/** Statuses of the stock offered as "absent from the file". */
const ABSENT_STATUSES: readonly ListingStatus[] = ["published", "paused"];

export interface StockEntry extends StockListing {
  fields: ImportedFields;
}

export interface PlannedUpdate {
  row: ParsedRow;
  listingId: string;
  patch: ListingPatch;
  /** New blocked periods of a car rental (absent: unchanged). */
  unavailable?: RentalPeriod[];
}

export interface ImportPlan {
  results: StockRowResult[];
  creates: ParsedRow[];
  updates: PlannedUpdate[];
  absent: StockListing[];
}

const blocking = (row: ParsedRow) => row.issues.some((issue) => !STOCK_WARNING_CODES.includes(issue.code));

/**
 * The listing's criteria with the line's on top: a column the file leaves out or empty keeps what
 * was set on the site (equipment ticked in the wizard), then the dependent criteria the result no
 * longer opens are dropped.
 */
function mergedAttributes(subcategoryId: string | null, before: ListingAttributes, next: ListingAttributes): ListingAttributes {
  const merged: ListingAttributes = { ...before, ...next };
  for (const criterion of subcategoryById(subcategoryId ?? "")?.criteria ?? []) {
    if (merged[criterion.id] !== undefined && !criterionApplies(criterion, merged)) delete merged[criterion.id];
  }
  return merged;
}

/** Patch of the fields a line changes on its listing (and its new blocked periods); empty when nothing differs. */
export function diffFields(row: ParsedRow, entry: Pick<StockEntry, "subcategoryId" | "fields">): { patch: ListingPatch; changes: string[]; unavailable?: RentalPeriod[] } {
  const patch: ListingPatch = {};
  const changes: string[] = [];
  const next = row.fields;
  const before = entry.fields;
  const set = <K extends keyof ListingPatch>(field: K, value: ListingPatch[K]) => {
    patch[field] = value;
    changes.push(field);
  };
  if (row.subcategoryId && row.subcategoryId !== entry.subcategoryId) set("subcategoryId", row.subcategoryId);
  // A title the import made up (no title column) never replaces the one written on the site.
  const generated = row.issues.some((issue) => issue.code === "title_generated");
  if (!generated && next.title !== before.title) set("title", next.title);
  // An empty description in the file keeps the one written on the site.
  if (next.description && next.description !== before.description) set("description", next.description);
  if (next.price !== before.price) set("price", next.price);
  if (next.priceNegotiable !== before.priceNegotiable) set("priceNegotiable", next.priceNegotiable);
  if (next.condition !== null && next.condition !== before.condition) set("condition", next.condition);
  // Another subcategory has other criteria: the line's only.
  const attributes = patch.subcategoryId ? next.attributes : mergedAttributes(entry.subcategoryId, before.attributes, next.attributes);
  if (patch.subcategoryId || !isDeepStrictEqual(attributes, before.attributes)) set("attributes", attributes);
  if (next.location && !isDeepStrictEqual(next.location, before.location)) set("location", next.location);
  if (next.unavailable && !isDeepStrictEqual(next.unavailable, before.unavailable ?? [])) {
    changes.push("unavailable");
    return { patch, changes, unavailable: next.unavailable };
  }
  return { patch, changes };
}

/** `remaining`: drafts the shop may still open (null = unlimited). */
export function planImport(rows: readonly ParsedRow[], stock: readonly StockEntry[], remaining: number | null): ImportPlan {
  const byRef = new Map(stock.map((entry) => [refKey(entry.ref), entry]));
  const seen = new Set<string>();
  const results: StockRowResult[] = [];
  const creates: ParsedRow[] = [];
  const updates: PlannedUpdate[] = [];
  let slots = remaining;

  for (const row of rows) {
    const issues = [...row.issues];
    const k = refKey(row.ref);
    const base = { line: row.line, ref: row.ref, title: row.fields.title };
    if (k && seen.has(k)) issues.push({ column: "reference", code: "ref_duplicate", value: row.ref });
    if (k) seen.add(k);
    const entry = k ? byRef.get(k) : undefined;
    const candidate = { ...row, issues };
    if (blocking(candidate)) {
      results.push({ ...base, action: "error", issues, ...(entry ? { listingId: entry.id } : {}) });
      continue;
    }
    if (entry) {
      if (!UPDATABLE_STATUSES.includes(entry.status)) {
        results.push({ ...base, action: "error", issues: [...issues, { column: "reference", code: "status_locked", value: entry.status }], listingId: entry.id });
        continue;
      }
      const { patch, changes, unavailable } = diffFields(candidate, entry);
      if (changes.length === 0) {
        results.push({ ...base, action: "unchanged", issues, listingId: entry.id });
      } else {
        updates.push({ row: candidate, listingId: entry.id, patch, ...(unavailable ? { unavailable } : {}) });
        results.push({ ...base, action: "update", issues, listingId: entry.id, changes });
      }
      continue;
    }
    if (slots !== null && slots <= 0) {
      results.push({ ...base, action: "error", issues: [...issues, { column: "reference", code: "quota" }] });
      continue;
    }
    if (slots !== null) slots -= 1;
    creates.push(candidate);
    results.push({ ...base, action: "create", issues });
  }

  const absent = stock
    .filter((entry) => ABSENT_STATUSES.includes(entry.status) && !seen.has(refKey(entry.ref)))
    .map(({ id, ref, title, status, photoCount, slugId, subcategoryId }) => ({ id, ref, title, status, photoCount, slugId, subcategoryId }));
  return { results, creates, updates, absent };
}
