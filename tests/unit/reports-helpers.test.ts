import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CreateReportRequest } from "@/lib/contracts/reports";
import { createReportSchema } from "@/lib/contracts/reports";
import { resetServerEnv } from "@/lib/env";
import { HttpError } from "@/lib/http/errors";
import { renderMail } from "@/lib/mail/render";

// Helpers of the reports around the rules: target keys, queue cursors and groups, legal holds, the
// checks of the notice before the limiters (D10), the visitor's language, the acknowledgement mail.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { parseTargetKey, splitMessageId, targetKey } = await import("@/lib/reports/target-key");
const { decodeCursor, encodeCursor, reportHold, withHold, HOLD_MAX } = await import("@/lib/reports/repository");
const { groupByTarget } = await import("@/lib/reports/admin");
const { assertReportInput } = await import("@/lib/reports/service");
const { visitorLocale } = await import("@/lib/reports/handlers");

const CID = "AbCdEfGhIjKlMnOpQrStUv";
const MID = "a1B2c3D4e5F6g7H8i9J0";

describe("target keys", () => {
  it("round-trips every stored id shape", () => {
    for (const target of [
      { type: "listing", id: "abcd2345" },
      { type: "user", id: "Uid_123-abc" },
      { type: "message", id: `${CID}/${MID}` },
      { type: "pro", id: "boutique-casa" },
    ] as const) {
      expect(parseTargetKey(targetKey(target))).toEqual(target);
    }
  });

  it("rejects malformed keys", () => {
    for (const key of ["", "listing", ":abcd2345", "listing:ABCD2345", "listing:abcd1234", "shop:x", "user:a b", `message:${CID}`, `message:${CID}/${MID}/x`, `user:${"x".repeat(200)}`]) {
      expect(parseTargetKey(key)).toBeNull();
    }
  });

  it("splits a message id", () => {
    expect(splitMessageId(`${CID}/${MID}`)).toEqual({ cid: CID, mid: MID });
    expect(splitMessageId(CID)).toBeNull();
  });
});

describe("queue cursors and groups", () => {
  it("round-trips a cursor and refuses tampered ones", () => {
    const cursor = { priority: "P1" as const, at: 1_760_000_000_000, id: "AbC123" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    for (const bad of ["", "%%%", Buffer.from("[1,2]").toString("base64url"), Buffer.from('["P9",1,"a"]').toString("base64url"), Buffer.from('["P1",-1,"a"]').toString("base64url"), Buffer.from('["P1",1,"a/b"]').toString("base64url"), "x".repeat(201)]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("groups a page by target, most urgent first", () => {
    const item = (id: string, key: string, priority: "P0" | "P1" | "P3", slaDueAt: string) =>
      ({ id, targetKey: key, priority, slaDueAt }) as Parameters<typeof groupByTarget>[0][number];
    const groups = groupByTarget([
      item("r1", "listing:abcd2345", "P3", "2026-10-20T00:00:00.000Z"),
      item("r2", "user:u1", "P1", "2026-10-17T00:00:00.000Z"),
      item("r3", "listing:abcd2345", "P0", "2026-10-16T13:00:00.000Z"),
    ]);
    expect(groups.map((group) => group.targetKey)).toEqual(["listing:abcd2345", "user:u1"]);
    expect(groups[0]).toEqual({ targetKey: "listing:abcd2345", priority: "P0", slaDueAt: "2026-10-16T13:00:00.000Z", reportIds: ["r1", "r3"] });
  });
});

describe("legal holds", () => {
  it("adds report:{id} once, never past the cap", () => {
    expect(reportHold("R1")).toBe("report:R1");
    expect(withHold(undefined, "report:R1")).toEqual(["report:R1"]);
    expect(withHold(["report:R1"], "report:R1")).toBeNull();
    expect(withHold(Array.from({ length: HOLD_MAX }, (_, i) => `h${i}`), "report:R2")).toBeNull();
  });
});

describe("assertReportInput (D10)", () => {
  const base = { target: { type: "listing", id: "abcd2345" }, reasonId: "scam", explanation: "Il demande une avance par Wafacash.", goodFaith: true } as const;
  const parse = (input: object) => createReportSchema.parse(input) as CreateReportRequest;
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof HttpError ? `${error.status} ${error.code}` : "other";
    }
    return "ok";
  };

  it("asks a visitor for a name and an e-mail address, except for P0 reasons", () => {
    expect(code(() => assertReportInput(parse(base), false))).toBe("400 invalid_body");
    expect(code(() => assertReportInput(parse({ ...base, name: "Nadia" }), false))).toBe("400 invalid_body");
    expect(code(() => assertReportInput(parse({ ...base, name: "Nadia", email: "nadia@example.com" }), false))).toBe("ok");
    expect(assertReportInput(parse({ ...base, reasonId: "minors" }), false)).toBe("P0");
    expect(assertReportInput(parse(base), true)).toBe("P1");
  });

  it("refuses a reason that does not fit the target, shops, and anonymous message reports", () => {
    expect(code(() => assertReportInput(parse({ ...base, reasonId: "harassment" }), true))).toBe("400 invalid_body");
    expect(code(() => assertReportInput(parse({ ...base, target: { type: "pro", id: "boutique" } }), true))).toBe("422 report_target_invalid");
    expect(code(() => assertReportInput(parse({ ...base, reasonId: "harassment", target: { type: "message", id: `${CID}/${MID}` } }), false))).toBe("401 unauthenticated");
  });

  it("the contract requires the good-faith statement and bounds the explanation", () => {
    expect(createReportSchema.safeParse({ ...base, goodFaith: false }).success).toBe(false);
    expect(createReportSchema.safeParse({ ...base, explanation: "court" }).success).toBe(false);
    expect(createReportSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe("visitorLocale", () => {
  it("prefers the language cookie, then the page, then French", () => {
    expect(visitorLocale(new Headers({ cookie: "NEXT_LOCALE=ar", referer: "https://joutiya.ma/rif/annonce/x" }))).toBe("ar");
    expect(visitorLocale(new Headers({ referer: "https://joutiya.ma/rif/annonce/x" }))).toBe("rif");
    expect(visitorLocale(new Headers({ cookie: "NEXT_LOCALE=en", referer: "not a url" }))).toBe("fr");
  });
});

describe("reportReceived mail (art. 16(4))", () => {
  beforeAll(() => {
    process.env.APP_ENV = "dev";
    process.env.SITE_URL = "https://staging.joutiya.ma";
    process.env.MAIL_FROM = "Joutiya <no-reply@notif.joutiya.ma>";
    resetServerEnv();
  });

  const data = { displayName: null, reportId: "AbCdEf0123456789wxyz", targetType: "listing" as const, reasonId: "minors", slaHours: 1, receivedAt: "2026-10-16T09:30:00.000Z", urgent: true };

  it("acknowledges in French with the reference, the reason label, the delay and the emergency numbers", () => {
    const mail = renderMail({ template: "reportReceived", locale: "fr", to: "v@example.com", data });
    expect(mail.subject).toBe("Nous avons bien reçu votre signalement");
    expect(mail.text).toContain("Bonjour,");
    expect(mail.text).toContain("AbCdEf0123456789wxyz");
    expect(mail.text).toContain("Mise en danger ou exploitation de mineurs");
    expect(mail.text).toContain("dans l'heure");
    expect(mail.text).toContain("17 en France");
  });

  it("acknowledges in Arabic, without the emergency line for a non-urgent report", () => {
    const mail = renderMail({ template: "reportReceived", locale: "ar", to: "v@example.com", data: { ...data, displayName: "نادية", reasonId: "scam", slaHours: 24, urgent: false } });
    expect(mail.subject).toBe("توصلنا بتبليغك");
    expect(mail.text).toContain("احتيال أو محاولة نصب");
    expect(mail.text).toContain("خلال 24 ساعة");
    expect(mail.text).not.toContain("19");
  });
});
