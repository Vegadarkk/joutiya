import { generateKeyPairSync, createVerify, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MAX_METADATA_BYTES,
  NAMES,
  OciError,
  SHAPE,
  bootstrapLines,
  buildUserData,
  isCapacityError,
  launchDetails,
  pickImage,
  securityList,
  signedHeaders,
  signingString,
} from "../../scripts/oracle-vm";

const template = readFileSync(new URL("../../infra/vm/bootstrap.sh", import.meta.url), "utf8");
const token = (tunnel: string): string => Buffer.from(JSON.stringify({ a: "0".repeat(32), t: tunnel, s: "c2VjcmV0" })).toString("base64");
const input = {
  template,
  sshTunnelToken: token("ssh"),
  stagingTunnelToken: token("staging"),
  prodTunnelToken: token("prod"),
  vmFiles: Buffer.from("tarball").toString("base64"),
};

describe("OCI request signing", () => {
  it("signs date, target and host, plus the body headers of a write", () => {
    const url = new URL("https://iaas.eu-paris-1.oraclecloud.com/20160918/vcns?compartmentId=x");
    expect(signingString("GET", url, { date: "D", host: url.host }).text).toBe(
      "date: D\n(request-target): get /20160918/vcns?compartmentId=x\nhost: iaas.eu-paris-1.oraclecloud.com",
    );
    expect(signingString("POST", url, {}).names).toEqual(["date", "(request-target)", "host", "content-length", "content-type", "x-content-sha256"]);
  });

  it("produces a signature the key's public half verifies", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const credentials = { tenancy: "ten", user: "usr", fingerprint: "aa:bb", region: "eu-paris-1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const url = new URL("https://iaas.eu-paris-1.oraclecloud.com/20160918/instances");
    const body = JSON.stringify({ displayName: "joutiya-vm" });
    const headers = signedHeaders(credentials, "POST", url, body, new Date("2026-10-16T00:00:00Z"));
    expect(headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(headers.authorization).toContain('keyId="ten/usr/aa:bb",algorithm="rsa-sha256"');
    const signature = /signature="([^"]+)"/.exec(headers.authorization ?? "")?.[1] ?? "";
    const { text } = signingString("POST", url, headers);
    expect(createVerify("RSA-SHA256").update(text).verify(publicKey, signature, "base64")).toBe(true);
  });
});

describe("cloud-init user data", () => {
  it("fills every placeholder of bootstrap.sh between single quotes, gzipped for cloud-init", () => {
    const script = gunzipSync(Buffer.from(buildUserData(input), "base64")).toString("utf8");
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    expect(script).not.toMatch(/__JOUTIYA_[A-Z_]+__/);
    expect(script).toContain(`SSH_TUNNEL_TOKEN='${input.sshTunnelToken}'`);
    expect(script).toContain(`PROD_TUNNEL_TOKEN='${input.prodTunnelToken}'`);
    expect(script).toContain(`VM_FILES='${input.vmFiles}'`);
  });

  it("refuses a value that could leave its quotes, a missing placeholder and oversized data", () => {
    expect(() => buildUserData({ ...input, prodTunnelToken: "x'; reboot; '" })).toThrow("prodTunnelToken is not a base64 value");
    expect(() => buildUserData({ ...input, template: template.replace("'__JOUTIYA_PROD_TUNNEL_TOKEN__'", "''") })).toThrow("found 0");
    expect(() => buildUserData({ ...input, vmFiles: randomBytes(MAX_METADATA_BYTES).toString("base64") })).toThrow("OCI allows");
  });
});

describe("instance", () => {
  it("launches an Always Free A1 with no SSH key, metadata v2 only and Run Command enabled", () => {
    const details = launchDetails({ availabilityDomain: "AD-1", compartmentId: "c", subnetId: "s", imageId: "i", userData: "u" });
    expect(details).toMatchObject({ displayName: NAMES.instance, shape: "VM.Standard.A1.Flex", shapeConfig: { ocpus: 2, memoryInGBs: 12 } });
    expect(details.metadata).toEqual({ user_data: "u" });
    expect(details.instanceOptions).toEqual({ areLegacyImdsEndpointsDisabled: true });
    expect(JSON.stringify(details.agentConfig)).toContain("Compute Instance Run Command");
    expect(SHAPE.ocpus * 6).toBe(SHAPE.memoryInGBs);
  });

  it("keeps the committed security list closed", () => {
    expect(securityList().ingressSecurityRules).toEqual([]);
  });

  it("picks the newest Ubuntu 24.04 aarch64 platform image, never Minimal", () => {
    const image = (displayName: string) => ({ id: displayName, displayName, lifecycleState: "AVAILABLE", operatingSystem: "Canonical Ubuntu", operatingSystemVersion: "24.04" });
    const picked = pickImage([
      image("Canonical-Ubuntu-24.04-aarch64-2026.08.25-0"),
      image("Canonical-Ubuntu-24.04-Minimal-aarch64-2026.09.30-0"),
      image("Canonical-Ubuntu-24.04-aarch64-2026.09.18-0"),
    ]);
    expect(picked.displayName).toBe("Canonical-Ubuntu-24.04-aarch64-2026.09.18-0");
    expect(() => pickImage([image("Canonical-Ubuntu-24.04-Minimal-aarch64-2026.09.30-0")])).toThrow("no Canonical");
  });

  it("retries on missing A1 capacity only", () => {
    expect(isCapacityError(new OciError(500, "InternalError", "Out of host capacity."))).toBe(true);
    expect(isCapacityError(new OciError(429, "TooManyRequests", "slow down"))).toBe(true);
    expect(isCapacityError(new OciError(400, "LimitExceeded", "quota"))).toBe(false);
    expect(isCapacityError(new Error("Out of host capacity"))).toBe(false);
  });

  it("reads the bootstrap progress from the serial console", () => {
    const console = "[  12.1] cloud-init[812]: noise\r\n[  30.2] joutiya-bootstrap: ssh tunnel installed\r\nCloud-init v. 25.1 finished at Fri, 16 Oct 2026. Up 300 seconds\r\n";
    expect(bootstrapLines(console)).toEqual(["joutiya-bootstrap: ssh tunnel installed", "Cloud-init v. 25.1 finished at Fri, 16 Oct 2026. Up 300 seconds"]);
  });
});
