import "server-only";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guards";
import { LISTING_STATUSES, listingPatchSchema, type ListingPatch, type ListingStatus } from "@/lib/contracts/listings";
import { STOCK_IMPORT_MAX_ROWS, type StockImportRequest, type StockImportResponse, type StockListing, type StockListResponse, type StockRowResult } from "@/lib/contracts/stock-import";
import { ACTIVE_STATUSES, listOwnerListingsByStatus, type ListingRecord } from "@/lib/db/repositories/listings";
import { HttpError } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { createDraft, patchListing, sellerOf, type Actor, type SellerContext } from "@/lib/listings/service";
import { CsvError, parseCsv } from "./csv";
import { planImport, type StockEntry } from "./plan";
import { STOCK_REF, parseRows, type ParsedRow } from "./rows";

// Stock import of a Pro shop (Concession pack, design concession/concession.md §4). The server
// parses the file (never trusting the browser's reading), reads the shop's listings once, plans
// every line (plan.ts) and, on apply, writes them one by one through the listing service: a new
// reference becomes a draft written with its fields, a known one is saved like a hand edit
// (readiness, screening, held for review when needed). A line that fails is reported, the others
// go on. Photos and publication follow in the browser, through the usual routes.

/** Listings read to find the stock (every status but removed and purged). */
export const STOCK_READ_MAX = 1000;
/** Drafts an import may leave open (besides the plan's active quota). */
export const STOCK_IMPORT_DRAFTS_MAX = STOCK_IMPORT_MAX_ROWS;

const STOCK_STATUSES: readonly ListingStatus[] = LISTING_STATUSES.filter((status) => status !== "removed" && status !== "purged");

interface Stock {
  records: Map<string, ListingRecord>;
  entries: StockEntry[];
  active: number;
  drafts: number;
}

const stockRefOf = (listing: ListingRecord) => {
  const ref = listing.attributes[STOCK_REF];
  return typeof ref === "string" && ref.trim() ? ref : null;
};

function toStockListing(listing: ListingRecord, ref: string): StockListing {
  return { id: listing.id, ref, title: listing.title, status: listing.status, photoCount: listing.photos.length, slugId: listing.slugId ?? null };
}

function entryOf(listing: ListingRecord, ref: string): StockEntry {
  const location = listing.location ? { regionCode: listing.location.regionCode, citySlug: listing.location.citySlug, ...(listing.location.district ? { district: listing.location.district } : {}) } : null;
  return {
    ...toStockListing(listing, ref),
    subcategoryId: listing.subcategoryId ?? null,
    fields: {
      title: listing.title,
      description: listing.description,
      price: listing.price,
      priceNegotiable: listing.priceNegotiable,
      condition: listing.condition ?? null,
      attributes: listing.attributes,
      location,
    },
  };
}

/** The owner's listings, their stock (those with a reference) and the slot counts; charged in documents read. */
async function readStock(uid: string): Promise<Stock> {
  const listings = await listOwnerListingsByStatus(uid, STOCK_STATUSES, STOCK_READ_MAX);
  if (listings.length > 1) await consumeLimit("listing.owner.read.uid", uid, listings.length - 1);
  const records = new Map<string, ListingRecord>();
  const entries: StockEntry[] = [];
  for (const listing of listings) {
    const ref = stockRefOf(listing);
    if (!ref) continue;
    records.set(listing.id, listing);
    entries.push(entryOf(listing, ref));
  }
  return {
    records,
    entries,
    active: listings.filter((listing) => ACTIVE_STATUSES.includes(listing.status)).length,
    drafts: listings.filter((listing) => listing.status === "draft").length,
  };
}

/**
 * Drafts the import may still open: the plan's active slots left (its drafts are meant to be
 * published), never more than STOCK_IMPORT_DRAFTS_MAX open drafts.
 */
export function remainingSlots(activeQuota: number | null, active: number, drafts: number): number {
  const cap = activeQuota === null ? STOCK_IMPORT_DRAFTS_MAX : Math.min(activeQuota - active, STOCK_IMPORT_DRAFTS_MAX);
  return Math.max(0, cap - drafts);
}

/** A Pro whose shop publishes (verified, not suspended); individuals have no stock import. */
async function proSeller(auth: AuthContext): Promise<SellerContext> {
  const seller = await sellerOf(auth);
  if (seller.seller.type !== "pro") throw new HttpError(403, "forbidden", "stock import is for Pro shops");
  if (seller.seller.plan === "none") throw new HttpError(409, "pro_not_verified");
  return seller;
}

/** GET /api/pro/stock: the shop's listings with a stock reference (photos and publish steps). */
export async function stockList(auth: AuthContext): Promise<StockListResponse> {
  await proSeller(auth);
  const stock = await readStock(auth.user.uid);
  return { listings: stock.entries.map(({ id, ref, title, status, photoCount, slugId }) => ({ id, ref, title, status, photoCount, slugId })) };
}

/** A patch through the wizard's own contract (null when it refuses it: the line fails, nothing is written). */
function checked(candidate: ListingPatch): ListingPatch | null {
  const parsed = listingPatchSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The fields of a new line, as the wizard would save them. */
function patchOf(row: ParsedRow): ListingPatch | null {
  const { fields } = row;
  return checked({
    title: fields.title,
    description: fields.description,
    attributes: fields.attributes,
    ...(fields.condition ? { condition: fields.condition } : {}),
    price: fields.price,
    priceNegotiable: fields.priceNegotiable,
    ...(fields.location ? { location: fields.location } : {}),
  });
}

function failed(result: StockRowResult, error: unknown): StockRowResult {
  const code = error instanceof HttpError ? error.code : "internal";
  logger.warn({ line: result.line, code }, "stock import line failed");
  return { ...result, action: "error", issues: [...result.issues, { column: "reference", code: code === "listing_limit" || code === "draft_limit" ? "quota" : "failed", value: code }] };
}

/**
 * POST /api/pro/stock/import. `preview` reads and plans, writes nothing. `apply` plans the same way,
 * then writes each line; the rows budget is consumed for the lines that write, before writing.
 */
export async function importStock(actor: Actor, input: StockImportRequest, now = new Date()): Promise<StockImportResponse> {
  const { uid } = actor.auth.user;
  const seller = await proSeller(actor.auth);
  let table;
  try {
    table = parseCsv(input.csv, STOCK_IMPORT_MAX_ROWS);
  } catch (error) {
    if (error instanceof CsvError) throw new HttpError(400, "invalid_csv", undefined, { details: { reason: error.code, line: error.line } });
    throw error;
  }
  const { rows, ignoredColumns } = parseRows(table, { pro: true });
  const stock = await readStock(uid);
  const remaining = remainingSlots(seller.quotas.activeListings, stock.active, stock.drafts);
  const plan = planImport(rows, stock.entries, remaining);
  if (input.mode === "preview") return { mode: "preview", rows: plan.results, absent: plan.absent, ignoredColumns, remaining };

  const writes = plan.creates.length + plan.updates.length;
  if (writes > 0) await enforceLimit("pro.import.rows.uid", uid, writes);

  const results = new Map(plan.results.map((result) => [result.line, result]));
  const maxDrafts = stock.drafts + remaining;
  let created = 0;
  let updated = 0;
  for (const row of plan.creates) {
    const result = results.get(row.line)!;
    const patch = patchOf(row);
    if (!patch || !row.subcategoryId) {
      results.set(row.line, failed(result, new HttpError(400, "invalid_body")));
      continue;
    }
    try {
      const { id } = await createDraft(actor, { subcategoryId: row.subcategoryId }, now, { maxDrafts, patch, seller });
      results.set(row.line, { ...result, listingId: id });
      created += 1;
    } catch (error) {
      results.set(row.line, failed(result, error));
    }
  }
  for (const update of plan.updates) {
    const result = results.get(update.row.line)!;
    const listing = stock.records.get(update.listingId)!;
    const patch = checked(update.patch);
    if (!patch) {
      results.set(update.row.line, failed(result, new HttpError(400, "invalid_body")));
      continue;
    }
    try {
      await patchListing(actor, update.listingId, patch, now, { imported: { listing, seller } });
      updated += 1;
    } catch (error) {
      results.set(update.row.line, failed(result, error));
    }
  }

  await audit({
    actorUid: uid,
    actorRole: actor.auth.user.claims.role ?? "pro",
    action: "pro.stock.import",
    target: { type: "pro", id: actor.auth.user.claims.proId ?? uid },
    automated: false,
    reason: `lines ${rows.length}, created ${created}, updated ${updated}, refused ${[...results.values()].filter((result) => result.action === "error").length}`,
    ip: actor.ip,
    at: now,
  });
  return { mode: "apply", rows: [...results.values()], absent: plan.absent, ignoredColumns, remaining: Math.max(0, remaining - created) };
}
