import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { certificateErrors, normalizeFingerprint, parseSealed, readCertificate, seal, sealedHeader } from "../../scripts/seal-env";

const dir = mkdtempSync(join(tmpdir(), "seal-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function keyPair(name: string): { key: string; pem: string } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.pem`);
  expect(spawnSync("openssl", ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", key]).status).toBe(0);
  expect(spawnSync("openssl", ["req", "-x509", "-new", "-key", key, "-subj", `/CN=${name}`, "-days", "2", "-out", cert]).status).toBe(0);
  return { key, pem: readFileSync(cert, "utf8") };
}

function open(block: string, key: string, pem: string): { status: number | null; stdout: string } {
  const file = join(dir, "block.pem");
  const cert = join(dir, "recipient.pem");
  writeFileSync(file, block);
  writeFileSync(cert, pem);
  const result = spawnSync("openssl", ["cms", "-decrypt", "-binary", "-inform", "PEM", "-in", file, "-inkey", key, "-recip", cert], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

const holder = keyPair("holder");
const other = keyPair("other");

describe("seal-env", () => {
  it("seals for the certificate's key only, with AES-256-GCM and RSA-OAEP", () => {
    const text = `${sealedHeader("staging", "app.env")}\nTURNSTILE_SECRET_KEY='secret value'\n`;
    const block = seal(text, holder.pem);
    expect(block).toMatch(/^-----BEGIN CMS-----\n[\s\S]+\n-----END CMS-----\n$/);
    expect(block).not.toContain("secret value");
    expect(open(block, holder.key, holder.pem)).toEqual({ status: 0, stdout: text });
    expect(open(block, other.key, other.pem).status).not.toBe(0);
    const printed = spawnSync("openssl", ["cms", "-cmsout", "-print", "-inform", "PEM"], { input: block, encoding: "utf8" }).stdout;
    expect(printed).toContain("authEnvelopedData");
    expect(printed).toContain("rsaesOaep");
    expect(printed).toContain("aes-256-gcm");
  });

  it("parses back its label and block, whatever the line endings, and nothing else", () => {
    const block = seal("x\n", holder.pem);
    const file = `${sealedHeader("staging", "tunnel.env")}\n${block}`;
    expect(parseSealed(file.replace(/\n/g, "\r\n"))).toEqual({ env: "staging", target: "tunnel.env", pem: block });
    expect(parseSealed(`\n  ${file.replace(/\n/g, "  \n\n")}`)).toEqual({ env: "staging", target: "tunnel.env", pem: block });
    expect(() => parseSealed(`joutiya-sealed v1 staging other.env\n${block}`)).toThrow("not a joutiya sealed file");
    expect(() => parseSealed(`${sealedHeader("prod", "app.env")}\nTUNNEL_TOKEN=abc\n`)).toThrow("not a joutiya sealed file");
  });

  it("pins the certificate by its fingerprint and its dates", () => {
    const fingerprint = new X509Certificate(holder.pem).fingerprint256;
    expect(certificateErrors(holder.pem, fingerprint.replace(/:/g, "").toLowerCase())).toEqual([]);
    expect(certificateErrors(holder.pem, new X509Certificate(other.pem).fingerprint256)).toEqual([expect.stringContaining("not the one given")]);
    expect(certificateErrors(holder.pem, fingerprint, new Date(Date.now() + 3 * 86_400_000))).toEqual([expect.stringContaining("valid from")]);
    expect(() => normalizeFingerprint("FE:66")).toThrow("64 hexadecimal digits");
  });

  it("reads the certificate from a PEM file or from the base64 DER the distro prints", () => {
    const der = new X509Certificate(holder.pem).raw.toString("base64");
    expect(readCertificate(join(dir, "holder.pem"))).toBe(new X509Certificate(holder.pem).toString());
    expect(readCertificate(der)).toBe(new X509Certificate(holder.pem).toString());
    expect(() => readCertificate("not a certificate")).toThrow("neither a certificate file nor a base64 certificate");
  });
});
