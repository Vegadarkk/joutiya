import "server-only";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Cloudflare Access token (`Cf-Access-Jwt-Assertion`), checked by the back office itself (§3, §6):
// Access is only the first lock at the edge, the app never relies on it alone.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export interface AccessIdentity {
  email: string;
  subject: string;
}

export interface AccessOptions {
  /** Team domain, e.g. "joutiya.cloudflareaccess.com" (scheme and trailing slash accepted). */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  audience: string;
  /** Key set override (tests); defaults to the team's published certificates, cached. */
  keys?: JWTVerifyGetKey;
}

const keySets = new Map<string, JWTVerifyGetKey>();

export function accessIssuer(teamDomain: string): string {
  const host = teamDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}`;
}

function teamKeys(issuer: string): JWTVerifyGetKey {
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000, cooldownDuration: 30_000 });
    keySets.set(issuer, keys);
  }
  return keys;
}

/** Verified identity of a person signed in through Access, or null (missing, forged, expired, service token). */
export async function verifyAccessJwt(token: string | null | undefined, options: AccessOptions): Promise<AccessIdentity | null> {
  if (!token || !options.teamDomain || !options.audience) return null;
  const issuer = accessIssuer(options.teamDomain);
  try {
    const { payload } = await jwtVerify(token, options.keys ?? teamKeys(issuer), {
      issuer,
      audience: options.audience,
      algorithms: ["RS256"],
    });
    if (typeof payload.email !== "string" || payload.email === "" || typeof payload.sub !== "string") return null;
    return { email: payload.email.toLowerCase(), subject: payload.sub };
  } catch {
    return null;
  }
}
