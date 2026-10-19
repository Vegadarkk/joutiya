import "server-only";
import { randomBytes } from "node:crypto";
import { pepperedHash, safeEqual } from "./hash";

// Device identifier (§6): random, in the signed __Host-did cookie. A client without it counts as
// an "unknown device" on its IP, with low thresholds.

/**
 * Request header carrying the verified device id to the render of a private page. Set by the
 * proxy only (src/proxy.ts strips any value sent by the client): a page reads it where the device
 * must be known before the first API call, such as the Google sign-in nonce.
 */
export const DEVICE_ID_HEADER = "x-device-id";

function signature(id: string): string {
  return pepperedHash("did", id).slice(0, 22);
}

/**
 * Nonce the auth pages hand Google Identity Services, derived from the device id: Google writes it
 * in the ID token's `nonce` claim and POST /api/auth/google recomputes it from the request's own
 * device cookie (src/lib/auth/google.ts). The browser never sends the nonce itself, and a token
 * minted on one device is refused from another (or without the cookie).
 */
export function gisNonce(deviceId: string): string {
  return pepperedHash("gis", deviceId);
}

export function newDeviceCookie(): { id: string; value: string } {
  const id = randomBytes(16).toString("base64url");
  return { id, value: `${id}.${signature(id)}` };
}

/** Device id of a signed cookie value, or null if absent or forged. */
export function readDeviceId(value: string | undefined): string | null {
  if (!value) return null;
  const [id, sig, extra] = value.split(".");
  if (!id || !sig || extra !== undefined || !/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
  return safeEqual(signature(id), sig) ? id : null;
}
