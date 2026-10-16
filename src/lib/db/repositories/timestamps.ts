import "server-only";
import { Timestamp } from "firebase-admin/firestore";

// Deep Timestamp <-> Date conversion for the phase 3 documents (staff.ts does it field by field;
// the listing schema nests dates under `boosts` and `moderation`, so one walk serves them all).
// Arrays and plain objects are traversed; anything else (strings, numbers, null, FieldValue
// sentinels) is returned as is.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** Firestore Timestamps become Dates, recursively (snapshot data -> schema input). */
export function timestampsToDates<T>(value: T): T {
  if (value instanceof Timestamp) return value.toDate() as unknown as T;
  if (Array.isArray(value)) return value.map((item) => timestampsToDates(item)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = timestampsToDates(item);
    return out as T;
  }
  return value;
}

/** Dates become Firestore Timestamps, recursively (schema output -> document to write). */
export function datesToTimestamps<T>(value: T): T {
  if (value instanceof Date) return Timestamp.fromDate(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => datesToTimestamps(item)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = datesToTimestamps(item);
    return out as T;
  }
  return value;
}
