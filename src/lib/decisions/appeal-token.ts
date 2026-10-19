import "server-only";
import { pepperedHash, safeEqual } from "@/lib/security/hash";

// Signed appeal links (art. 20 DSA, design D16): banned accounts and reporters cannot sign in to
// appeal, so the decision and outcome mails carry a link. Token = base64url(payload) + "." + HMAC
// of the payload under HASH_PEPPER, purpose "appeal:v1". Payload "v1.{decisionId}.{by}.{reportId|-}
// .{exp}" with exp = the appeal deadline (epoch seconds). The token only opens an appeal on that
// decision, once, before the deadline: it is not a session.

const PURPOSE = "appeal:v1";
const VERSION = "v1";
const DOC_ID = /^[A-Za-z0-9]{20}$/;

export type AppealBy = "affected" | "reporter";

export interface AppealTokenClaims {
  decisionId: string;
  by: AppealBy;
  /** The reporter's report (by "reporter"). */
  reportId?: string;
  /** Appeal deadline. */
  expiresAt: Date;
}

function signature(payload: string): string {
  return pepperedHash(PURPOSE, payload);
}

export function appealToken(claims: AppealTokenClaims): string {
  if (!DOC_ID.test(claims.decisionId)) throw new Error("invalid decision id");
  if (claims.by === "reporter" ? !claims.reportId || !DOC_ID.test(claims.reportId) : claims.reportId !== undefined) throw new Error("invalid appeal token claims");
  const exp = Math.floor(claims.expiresAt.getTime() / 1000);
  const payload = [VERSION, claims.decisionId, claims.by, claims.reportId ?? "-", String(exp)].join(".");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${signature(payload)}`;
}

export type AppealTokenResult = { ok: true; claims: AppealTokenClaims } | { ok: false; reason: "invalid" | "expired" };

/** Verifies a token: "invalid" for anything tampered or malformed, "expired" past the deadline. */
export function verifyAppealToken(token: string, now = new Date()): AppealTokenResult {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return { ok: false, reason: "invalid" };
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, reason: "invalid" };
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  if (!safeEqual(signature(payload), sig)) return { ok: false, reason: "invalid" };
  const [version, decisionId, by, reportId, exp, ...rest] = payload.split(".");
  if (rest.length > 0 || version !== VERSION || !decisionId || !DOC_ID.test(decisionId)) return { ok: false, reason: "invalid" };
  if (by !== "affected" && by !== "reporter") return { ok: false, reason: "invalid" };
  if (by === "reporter" ? !reportId || !DOC_ID.test(reportId) : reportId !== "-") return { ok: false, reason: "invalid" };
  if (!exp || !/^\d{1,12}$/.test(exp)) return { ok: false, reason: "invalid" };
  const expiresAt = new Date(Number(exp) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, claims: { decisionId, by, ...(by === "reporter" && reportId ? { reportId } : {}), expiresAt } };
}
