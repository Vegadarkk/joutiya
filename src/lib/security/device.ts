import "server-only";
import { randomBytes } from "node:crypto";
import { pepperedHash, safeEqual } from "./hash";

// Device identifier (§6): random, in the signed __Host-did cookie. A client without it counts as
// an "unknown device" on its IP, with low thresholds.

function signature(id: string): string {
  return pepperedHash("did", id).slice(0, 22);
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
