import "server-only";
import { pepperedHash, safeEqual } from "@/lib/security/hash";

// One-click unsubscribe links of the saved-search alerts (design D20): no session, the token
// authenticates. Token = base64url("v1.<uid>.<searchId|*>") + "." + HMAC of that payload under a
// secret derived from HASH_PEPPER (purpose "alerts-unsubscribe"). "*" turns off every alert of the
// account. No expiry: an old e-mail must still unsubscribe (RFC 8058); the token can do nothing else.

export const UNSUBSCRIBE_ALL = "*";
const PURPOSE = "alerts-unsubscribe";
const VERSION = "v1";
const SEARCH_ID = /^[A-Za-z0-9]{20}$/;
/** Firebase uids: 1-128 characters; never a path separator (the uid becomes a document path). */
const UID = /^[^/\s]{1,128}$/;

export interface UnsubscribeTarget {
  uid: string;
  /** A saved search id, or "*" for every alert of the account. */
  searchId: string;
}

function signature(payload: string): string {
  return pepperedHash(PURPOSE, payload);
}

export function unsubscribeToken(uid: string, searchId: string = UNSUBSCRIBE_ALL): string {
  if (!UID.test(uid) || !(searchId === UNSUBSCRIBE_ALL || SEARCH_ID.test(searchId))) throw new Error("invalid unsubscribe target");
  const payload = `${VERSION}.${uid}.${searchId}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${signature(payload)}`;
}

/** The target of a valid token, null for anything else (tampered, truncated, other version). */
export function verifyUnsubscribeToken(token: string): UnsubscribeTarget | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  if (!safeEqual(signature(payload), sig)) return null;
  const first = payload.indexOf(".");
  const last = payload.lastIndexOf(".");
  if (payload.slice(0, first) !== VERSION || last <= first) return null;
  const uid = payload.slice(first + 1, last);
  const searchId = payload.slice(last + 1);
  if (!UID.test(uid) || !(searchId === UNSUBSCRIBE_ALL || SEARCH_ID.test(searchId))) return null;
  return { uid, searchId };
}
