import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { accessIssuer, verifyAccessJwt, type AccessOptions } from "@/lib/auth/access-jwt";

const TEAM = "joutiya.cloudflareaccess.com";
const AUD = "a".repeat(64);
let privateKey: CryptoKey;
let options: AccessOptions;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  options = { teamDomain: `https://${TEAM}/`, audience: AUD, keys: createLocalJWKSet({ keys: [jwk] }) };
});

function token(claims: JWTPayload, { issuer = `https://${TEAM}`, audience = AUD, expires = "5m" } = {}) {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(privateKey);
}

describe("verifyAccessJwt", () => {
  it("normalizes the team domain", () => {
    expect(accessIssuer("https://joutiya.cloudflareaccess.com/")).toBe("https://joutiya.cloudflareaccess.com");
    expect(accessIssuer("joutiya.cloudflareaccess.com")).toBe("https://joutiya.cloudflareaccess.com");
  });

  it("returns the identity of a valid token", async () => {
    expect(await verifyAccessJwt(await token({ email: "Owner@Joutiya.ma", sub: "u1" }), options)).toEqual({ email: "owner@joutiya.ma", subject: "u1" });
  });

  it("rejects missing, foreign, expired and service tokens", async () => {
    expect(await verifyAccessJwt(null, options)).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", options)).toBeNull();
    expect(await verifyAccessJwt(await token({ email: "a@b.c", sub: "u" }, { audience: "b".repeat(64) }), options)).toBeNull();
    expect(await verifyAccessJwt(await token({ email: "a@b.c", sub: "u" }, { issuer: "https://other.cloudflareaccess.com" }), options)).toBeNull();
    expect(await verifyAccessJwt(await token({ email: "a@b.c", sub: "u" }, { expires: "-1m" }), options)).toBeNull();
    expect(await verifyAccessJwt(await token({ common_name: "ci-token", sub: "" }), options)).toBeNull();
  });

  it("refuses to verify without configuration", async () => {
    expect(await verifyAccessJwt(await token({ email: "a@b.c", sub: "u" }), { ...options, audience: "" })).toBeNull();
  });
});
