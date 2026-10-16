import { DocumentReference, FieldValue, Firestore, GeoPoint, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { BackupFormatError, decodeDocument, decodeValue, encodeDocument, encodeValue, isDocumentPath, parseBackupLine } from "@/lib/backup/encode";

// Firestore value <-> JSON of the backups (D17): every Firestore type survives the NDJSON line.
// The client never connects: references are built offline.

const db = new Firestore({ projectId: "demo-backup-unit" });

function roundTrip(value: unknown): unknown {
  return decodeValue(JSON.parse(JSON.stringify(encodeValue(value))), db);
}

describe("encodeValue / decodeValue", () => {
  it("keeps JSON scalars as they are", () => {
    for (const value of [null, true, false, 0, 42, -7.5, 1e300, "", "texte é ب ⵣ"]) {
      expect(encodeValue(value)).toBe(value);
      expect(roundTrip(value)).toBe(value);
    }
  });

  it("round-trips a Timestamp with nanosecond precision, and a Date as a Timestamp", () => {
    const ts = new Timestamp(1_792_000_000, 123_456_789);
    const back = roundTrip(ts) as Timestamp;
    expect(back).toBeInstanceOf(Timestamp);
    expect(back.isEqual(ts)).toBe(true);
    expect(encodeValue(ts)).toEqual({ __t: "ts", s: 1_792_000_000, n: 123_456_789 });
    const date = new Date("2026-10-16T03:30:00.250Z");
    const fromDate = roundTrip(date) as Timestamp;
    expect(fromDate).toBeInstanceOf(Timestamp);
    expect(fromDate.toDate().toISOString()).toBe(date.toISOString());
    const negative = new Timestamp(-86_400, 5);
    expect((roundTrip(negative) as Timestamp).isEqual(negative)).toBe(true);
  });

  it("round-trips GeoPoint, bytes and references", () => {
    const geo = roundTrip(new GeoPoint(33.5731, -7.5898)) as GeoPoint;
    expect(geo).toBeInstanceOf(GeoPoint);
    expect(geo.isEqual(new GeoPoint(33.5731, -7.5898))).toBe(true);

    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const backBytes = roundTrip(bytes) as Buffer;
    expect(Buffer.isBuffer(backBytes)).toBe(true);
    expect([...backBytes]).toEqual([0, 1, 2, 254, 255]);
    // A Buffer that is a view on a larger pool keeps only its own bytes.
    const view = Buffer.from([9, 9, 7, 8, 9]).subarray(2, 4);
    expect([...(roundTrip(view) as Buffer)]).toEqual([7, 8]);

    const ref = roundTrip(db.doc("users/u1/private/account")) as DocumentReference;
    expect(ref).toBeInstanceOf(DocumentReference);
    expect(ref.path).toBe("users/u1/private/account");
    expect(ref.firestore).toBe(db);
  });

  it("round-trips non-finite numbers, -0 and bigint", () => {
    expect(Number.isNaN(roundTrip(Number.NaN))).toBe(true);
    expect(roundTrip(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundTrip(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    expect(roundTrip(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);
  });

  it("round-trips nested maps and arrays, and never reads user data as a tag", () => {
    const value = {
      a: [1, "x", [true, null], { b: new Timestamp(10, 0) }],
      m: { deep: { deeper: { geo: new GeoPoint(-90, 180) } } },
      empty: {},
      none: [],
      __t: "ts",
      spoof: { __t: "ref", path: "../../etc" },
    };
    const back = roundTrip(value) as Record<string, unknown>;
    expect(back["__t"]).toBe("ts");
    expect(back["spoof"]).toEqual({ __t: "ref", path: "../../etc" });
    expect(back["empty"]).toEqual({});
    expect(back["none"]).toEqual([]);
    const a = back["a"] as unknown[];
    expect(a.slice(0, 3)).toEqual([1, "x", [true, null]]);
    expect(((a[3] as Record<string, unknown>)["b"] as Timestamp).isEqual(new Timestamp(10, 0))).toBe(true);
    const geo = (((back["m"] as Record<string, unknown>)["deep"] as Record<string, unknown>)["deeper"] as Record<string, unknown>)["geo"] as GeoPoint;
    expect(geo.isEqual(new GeoPoint(-90, 180))).toBe(true);
  });

  it("drops undefined fields and refuses values Firestore never returns", () => {
    expect(encodeValue({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(() => encodeValue(FieldValue.serverTimestamp())).toThrow(TypeError);
    expect(() => encodeValue(new Map())).toThrow(TypeError);
    expect(() => encodeValue(() => 1)).toThrow(TypeError);
  });

  it("rejects malformed tagged values", () => {
    const bad: unknown[] = [
      { __t: "nope" },
      { __t: 5 },
      { __t: "ts", s: "1", n: 0 },
      { __t: "geo", lat: 1 },
      { __t: "ref", path: 7 },
      { __t: "ref", path: "users" },
      { __t: "ref", path: "users//x/y" },
      { __t: "bytes" },
      { __t: "num", v: "12" },
      { __t: "int", v: "1.5" },
      { __t: "map", m: [] },
    ];
    for (const value of bad) expect(() => decodeValue(value as never, db), JSON.stringify(value)).toThrow(BackupFormatError);
  });
});

describe("document lines", () => {
  const snapshot = (path: string, data: Record<string, unknown> | undefined, updateTime: Timestamp | undefined) =>
    ({ ref: db.doc(path), data: () => data, updateTime }) as unknown as DocumentSnapshot;

  it("encodes one snapshot per line and decodes it back with its path", () => {
    const line = encodeDocument(snapshot("users/u1/private/account", { phone: "+212600000000", at: new Timestamp(5, 0), raw: Buffer.from("a\nb") }, new Timestamp(1_792_000_000, 0)));
    expect(line).not.toContain("\n");
    const decoded = decodeDocument(line, db);
    expect(decoded.ref.path).toBe("users/u1/private/account");
    expect(decoded.rootCollection).toBe("users");
    expect(decoded.collection).toBe("private");
    expect(decoded.updateTime?.toISOString()).toBe(new Timestamp(1_792_000_000, 0).toDate().toISOString());
    expect(decoded.data["phone"]).toBe("+212600000000");
    expect((decoded.data["at"] as Timestamp).isEqual(new Timestamp(5, 0))).toBe(true);
    expect((decoded.data["raw"] as Buffer).toString()).toBe("a\nb");
  });

  it("keeps an unknown update time as null and refuses a missing document", () => {
    expect(parseBackupLine(encodeDocument(snapshot("listings/l1", { a: 1 }, undefined))).u).toBeNull();
    expect(() => encodeDocument(snapshot("listings/l1", undefined, undefined))).toThrow(/does not exist/);
  });

  it("validates the shape of a line", () => {
    const valid = { p: "listings/l1", d: {}, u: null };
    expect(parseBackupLine(JSON.stringify(valid))).toEqual(valid);
    for (const line of ["", "{", "[]", "null", JSON.stringify({ ...valid, p: "listings" }), JSON.stringify({ ...valid, p: "a/b/c" }), JSON.stringify({ ...valid, p: "a//b/c" }), JSON.stringify({ ...valid, d: [] }), JSON.stringify({ ...valid, u: "hier" }), JSON.stringify({ ...valid, p: `a/${"x".repeat(1_500)}` })]) {
      expect(() => parseBackupLine(line), line.slice(0, 40)).toThrow(BackupFormatError);
    }
  });

  it("recognises document paths", () => {
    expect(isDocumentPath("users/u1")).toBe(true);
    expect(isDocumentPath("users/u1/private/account")).toBe(true);
    for (const path of ["", "users", "users/u1/private", "/users/u1", "users/u1/"]) expect(isDocumentPath(path), path).toBe(false);
  });
});
