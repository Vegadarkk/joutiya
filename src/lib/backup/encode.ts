import { DocumentReference, GeoPoint, Timestamp, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore";

// Firestore value <-> JSON (D17). Scalars JSON carries as is stay as is; every other Firestore type
// becomes a tagged object { __t: "<tag>", ... }: Timestamp, GeoPoint, DocumentReference, bytes,
// non-finite numbers and -0. A plain map whose own keys include "__t" is wrapped in
// { __t: "map", m: {...} }, so user data can never be read back as a tag. One NDJSON line per
// document: { p: "<collection>/<docId>[/sub/...]", d: <encoded data>, u: <updateTime ISO | null> }.
//
// Pure module: no "server-only", no "@/" alias and ".ts" relative imports, so that
// scripts/restore-firestore.ts runs it under plain Node (type stripping, no bundler).

export type EncodedValue = null | boolean | number | string | EncodedValue[] | EncodedMap;
export interface EncodedMap {
  [key: string]: EncodedValue;
}

const TAG = "__t";

export interface BackupLine {
  /** Document path relative to the database root ("listings/abc", "users/u1/private/account"). */
  p: string;
  d: EncodedMap;
  /** Firestore updateTime of the exported snapshot (ISO 8601), null when unknown. */
  u: string | null;
}

export interface DecodedDocument {
  ref: DocumentReference;
  /** Root collection of the path ("users" for "users/u1/private/account"). */
  rootCollection: string;
  /** Collection the document sits in ("private" for "users/u1/private/account"). */
  collection: string;
  data: Record<string, unknown>;
  updateTime: Date | null;
}

/** What decoding needs from Firestore: references are rebuilt in the target database. */
export type RefResolver = Pick<Firestore, "doc">;

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFormatError";
  }
}

/** "collection/doc[/collection/doc...]": an even number of non-empty segments. */
export function isDocumentPath(path: string): boolean {
  const segments = path.split("/");
  return path.length <= 1_500 && segments.length >= 2 && segments.length % 2 === 0 && segments.every((segment) => segment.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeEntries(map: Record<string, unknown>): EncodedMap {
  const out: EncodedMap = {};
  for (const [key, value] of Object.entries(map)) {
    // Admin SDK with ignoreUndefinedProperties: an undefined field is not a field.
    if (value !== undefined) out[key] = encodeValue(value);
  }
  return out;
}

/** Firestore value (as returned by DocumentSnapshot.data()) -> JSON-safe value. Throws on an unknown type. */
export function encodeValue(value: unknown): EncodedValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    return { [TAG]: "num", v: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (typeof value === "bigint") return { [TAG]: "int", v: value.toString() };
  if (value instanceof Timestamp) return { [TAG]: "ts", s: value.seconds, n: value.nanoseconds };
  if (value instanceof Date) {
    const ts = Timestamp.fromDate(value);
    return { [TAG]: "ts", s: ts.seconds, n: ts.nanoseconds };
  }
  if (value instanceof GeoPoint) return { [TAG]: "geo", lat: value.latitude, lng: value.longitude };
  if (value instanceof DocumentReference) return { [TAG]: "ref", path: value.path };
  if (value instanceof Uint8Array) return { [TAG]: "bytes", b64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (Array.isArray(value)) return value.map((item) => encodeValue(item));
  if (isPlainObject(value)) {
    const entries = encodeEntries(value);
    return Object.hasOwn(entries, TAG) ? { [TAG]: "map", m: entries } : entries;
  }
  throw new TypeError(`unsupported Firestore value: ${Object.prototype.toString.call(value)}`);
}

function expectNumber(value: EncodedValue | undefined, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BackupFormatError(`${what}: number expected`);
  return value;
}

function expectString(value: EncodedValue | undefined, what: string): string {
  if (typeof value !== "string") throw new BackupFormatError(`${what}: string expected`);
  return value;
}

function expectMap(value: EncodedValue | undefined, what: string): EncodedMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BackupFormatError(`${what}: object expected`);
  return value;
}

function decodeEntries(map: EncodedMap, db: RefResolver): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) out[key] = decodeValue(value, db);
  return out;
}

const NON_FINITE: Record<string, number> = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, "-Infinity": Number.NEGATIVE_INFINITY, "-0": -0 };

/** Inverse of encodeValue; `db` resolves document references. Throws BackupFormatError on a malformed value. */
export function decodeValue(value: EncodedValue, db: RefResolver): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, db));
  const tag = value[TAG];
  if (tag === undefined) return decodeEntries(value, db);
  if (typeof tag !== "string") throw new BackupFormatError("tag must be a string");
  switch (tag) {
    case "ts":
      return new Timestamp(expectNumber(value["s"], "ts.s"), expectNumber(value["n"], "ts.n"));
    case "geo":
      return new GeoPoint(expectNumber(value["lat"], "geo.lat"), expectNumber(value["lng"], "geo.lng"));
    case "ref": {
      const path = expectString(value["path"], "ref.path");
      if (!isDocumentPath(path)) throw new BackupFormatError(`ref.path: "${path}" is not a document path`);
      return db.doc(path);
    }
    case "bytes":
      return Buffer.from(expectString(value["b64"], "bytes.b64"), "base64");
    case "num": {
      const repr = expectString(value["v"], "num.v");
      if (!Object.hasOwn(NON_FINITE, repr)) throw new BackupFormatError(`num.v: unexpected "${repr}"`);
      return NON_FINITE[repr];
    }
    case "int": {
      const repr = expectString(value["v"], "int.v");
      if (!/^-?\d+$/.test(repr)) throw new BackupFormatError("int.v: integer expected");
      return BigInt(repr);
    }
    case "map":
      return decodeEntries(expectMap(value["m"], "map.m"), db);
    default:
      throw new BackupFormatError(`unknown tag "${tag}"`);
  }
}

/** One NDJSON line for a snapshot of an existing document. JSON.stringify never emits a raw newline. */
export function encodeDocument(snapshot: DocumentSnapshot): string {
  const data = snapshot.data();
  if (data === undefined) throw new Error(`document ${snapshot.ref.path} does not exist`);
  const line: BackupLine = { p: snapshot.ref.path, d: encodeEntries(data), u: snapshot.updateTime ? snapshot.updateTime.toDate().toISOString() : null };
  return JSON.stringify(line);
}

/** Parses and validates the shape of one NDJSON line (no decoding yet). */
export function parseBackupLine(line: string): BackupLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new BackupFormatError("line is not JSON");
  }
  if (!isPlainObject(parsed)) throw new BackupFormatError("line must be a JSON object");
  const { p, d, u } = parsed;
  if (typeof p !== "string" || p.length === 0 || p.length > 1_500) throw new BackupFormatError("p: document path expected");
  if (!isDocumentPath(p)) throw new BackupFormatError(`p: "${p}" is not a document path`);
  if (!isPlainObject(d)) throw new BackupFormatError("d: object expected");
  if (u !== null && (typeof u !== "string" || Number.isNaN(Date.parse(u)))) throw new BackupFormatError("u: ISO date or null expected");
  return { p, d: d as EncodedMap, u };
}

/** NDJSON line -> reference, data ready for set(), update time. */
export function decodeDocument(line: string, db: RefResolver): DecodedDocument {
  const parsed = parseBackupLine(line);
  const segments = parsed.p.split("/");
  const ref = db.doc(parsed.p);
  return {
    ref,
    rootCollection: segments[0] as string,
    collection: segments[segments.length - 2] as string,
    data: decodeEntries(parsed.d, db),
    updateTime: parsed.u === null ? null : new Date(parsed.u),
  };
}
