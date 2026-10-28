import type { ProPlan } from "@/config/pricing";
import { z } from "@/lib/zod";
import type { ListingStatus } from "@/lib/contracts/listings";

// Stock import of a Pro shop (Concession pack, design concession/concession.md §4): a CSV file,
// read in the browser and sent as text, parsed by the server. `preview` writes nothing and says
// what each line would do; `apply` creates the new lines as drafts and updates the listings whose
// stock reference already exists. Photos come afterwards, by file name (`REF-1.jpg`), through the
// usual upload pipeline. Client-safe: no env, no db.

/** Bytes of the CSV text (UTF-8). */
export const STOCK_IMPORT_MAX_BYTES = 1_000_000;
/** Data lines of one file (the header excluded). */
export const STOCK_IMPORT_MAX_ROWS = 300;
/** Upper bound of the request body: the text escaped in JSON, plus the envelope. */
export const STOCK_IMPORT_BODY_MAX_BYTES = 2 * STOCK_IMPORT_MAX_BYTES + 1024;

export const STOCK_IMPORT_MODES = ["preview", "apply"] as const;
export type StockImportMode = (typeof STOCK_IMPORT_MODES)[number];

export const stockImportRequestSchema = z
  .object({
    mode: z.enum(STOCK_IMPORT_MODES),
    csv: z.string().min(1).max(STOCK_IMPORT_MAX_BYTES),
  })
  .strict();
export type StockImportRequest = z.infer<typeof stockImportRequestSchema>;

/** Stock references compare without case or surrounding spaces. */
export const refKey = (ref: string) => ref.trim().toLowerCase();

/** What a line does: a new draft, an update of the listing with its reference, nothing, or an error. */
export const STOCK_ROW_ACTIONS = ["create", "update", "unchanged", "error"] as const;
export type StockRowAction = (typeof STOCK_ROW_ACTIONS)[number];

/**
 * Codes of a line's problems, by column (messages StockImport.codes.*). `warning` problems leave the
 * line importable (a draft completed later); the others refuse it.
 */
export const STOCK_ROW_CODES = [
  "ref_required",
  "ref_invalid",
  "ref_duplicate",
  "category_unknown",
  "value_unknown",
  "number_invalid",
  "required",
  "city_unknown",
  "price_invalid",
  "too_long",
  "pro_only",
  "status_locked",
  "quota",
  "description_short",
  "title_generated",
  "column_ignored",
  "failed",
] as const;
export type StockRowCode = (typeof STOCK_ROW_CODES)[number];

export const STOCK_WARNING_CODES: readonly StockRowCode[] = ["description_short", "title_generated", "column_ignored"];

export interface StockRowIssue {
  /** Header as written in the file (or the field when no column applies). */
  column: string;
  code: StockRowCode;
  /** The value read, cut to 80 characters (shown to help the fix). */
  value?: string;
}

export interface StockRowResult {
  /** 1-based line of the file, the header being line 1. */
  line: number;
  ref: string;
  title: string;
  action: StockRowAction;
  issues: StockRowIssue[];
  /** The listing created or updated (apply), or the one the reference matches (preview). */
  listingId?: string;
  /** Fields an update changes. */
  changes?: string[];
}

/** A listing of the stock (one with a stock reference), for the photos and publish steps. */
export interface StockListing {
  id: string;
  ref: string;
  title: string;
  status: ListingStatus;
  photoCount: number;
  slugId: string | null;
  /** Its subcategory: real estate needs the advertiser's attestation at publication. */
  subcategoryId: string | null;
}

export interface StockImportResponse {
  mode: StockImportMode;
  rows: StockRowResult[];
  /** Published or paused listings whose reference is not in the file (offered as sold, never automatic). */
  absent: StockListing[];
  /** Columns of the header that map to nothing. */
  ignoredColumns: string[];
  /** Active slots and drafts the shop can still open (null = unlimited). */
  remaining: number | null;
}

export interface StockListResponse {
  listings: StockListing[];
}

/** Pro plans with the stock import (owner's choice, 28 Oct 2026: the upper plans only). */
export const STOCK_IMPORT_PLANS: readonly ProPlan[] = ["business", "premium"];

export const importsStock = (plan: ProPlan): boolean => STOCK_IMPORT_PLANS.includes(plan);

export const STOCK_API = {
  list: "/api/pro/stock",
  import: "/api/pro/stock/import",
} as const;
