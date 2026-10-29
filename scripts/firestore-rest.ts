// JSON values as Firestore REST values, for the scripts that write a `config/*` document
// (scripts/legal-config.ts, scripts/abuse-config.ts) through the REST API.

/** A JSON value as a Firestore REST value (strings, numbers, booleans, null, lists, maps). */
export function firestoreValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: value.length === 0 ? {} : { values: value.map(firestoreValue) } };
  if (typeof value === "object") return { mapValue: { fields: firestoreFields(value as Record<string, unknown>) } };
  throw new Error(`cannot store ${typeof value} in Firestore`);
}

export function firestoreFields(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, firestoreValue(value)]));
}
