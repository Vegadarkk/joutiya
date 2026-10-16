import { filterKind } from "./settings";
import type { FilterExpr, FilterValue } from "./types";

// FilterExpr -> Meilisearch filter string (design D1). Field names come from code, never from a
// request, and are still checked against the filterable list: an unknown field or an operator the
// field does not allow throws InvalidFilterError (a programming error, never a 503). String values
// are always double-quoted with backslashes then quotes escaped: Meilisearch unescapes `\\` and
// `\"` inside quotes, and an unescaped quote would let a value close the string and inject
// `OR ...` (verified on 1.55.0). Control characters become spaces (the parser would read `\n`).

export class InvalidFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFilterError";
  }
}

/** Double-quoted Meilisearch string literal. */
export function quoteFilterValue(value: string): string {
  return `"${value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function number(value: number, what: string): string {
  // Plain decimal notation only (String(1e21) would print an exponent).
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) throw new InvalidFilterError(`${what}: not a finite number`);
  return String(value);
}

function literal(value: FilterValue, field: string): string {
  if (typeof value === "string") return quoteFilterValue(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return number(value, field);
}

function checkField(field: string, comparison: boolean): void {
  const kind = filterKind(field);
  if (!kind || kind === "geo") throw new InvalidFilterError(`field not filterable: ${field}`);
  if (comparison && kind !== "comparison") throw new InvalidFilterError(`field does not allow comparisons: ${field}`);
}

/** Throws InvalidFilterError when `expr` uses an unknown field, a forbidden operator or a bad number. */
export function assertFilter(expr: FilterExpr): void {
  toMeiliFilter(expr);
}

/** Field names a facet request may use (the same list as equality filters). */
export function assertFacets(facets: readonly string[]): void {
  for (const facet of facets) {
    const kind = filterKind(facet);
    if (!kind || kind === "geo") throw new InvalidFilterError(`field not facetable: ${facet}`);
  }
}

/** Meilisearch filter string; "" when the expression is an empty AND (no restriction). */
export function toMeiliFilter(expr: FilterExpr): string {
  if ("and" in expr) {
    const parts = expr.and.map(toMeiliFilter).filter(Boolean);
    if (parts.length <= 1) return parts[0] ?? "";
    return parts.map((part) => `(${part})`).join(" AND ");
  }
  if ("or" in expr) {
    // An empty OR matches nothing; an empty AND inside an OR matches everything.
    const parts = expr.or.map(toMeiliFilter);
    if (parts.length === 0) return "id IN []";
    if (parts.some((part) => part === "")) return "";
    if (parts.length === 1) return parts[0] ?? "";
    return parts.map((part) => `(${part})`).join(" OR ");
  }
  if ("not" in expr) {
    const inner = toMeiliFilter(expr.not);
    return inner ? `NOT (${inner})` : "id IN []";
  }
  if ("geoRadius" in expr) {
    const { lat, lng, meters } = expr.geoRadius;
    if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) throw new InvalidFilterError("geoRadius: invalid point");
    if (!(meters > 0)) throw new InvalidFilterError("geoRadius: radius must be positive");
    return `_geoRadius(${number(lat, "lat")}, ${number(lng, "lng")}, ${number(Math.round(meters), "meters")})`;
  }
  switch (expr.op) {
    case "eq":
      checkField(expr.field, false);
      return `${expr.field} = ${literal(expr.value, expr.field)}`;
    case "in":
      checkField(expr.field, false);
      return `${expr.field} IN [${expr.values.map((value) => literal(value, expr.field)).join(", ")}]`;
    case "exists":
      checkField(expr.field, false);
      return `${expr.field} EXISTS`;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      checkField(expr.field, true);
      const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[expr.op];
      return `${expr.field} ${op} ${number(expr.value, expr.field)}`;
    }
  }
}
