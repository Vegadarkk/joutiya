import { spawnSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import registry from "../../infra/targets.json";
import { SHAPE, SMALL_SHAPE_CONFIG, consoleCloudInit } from "../../scripts/oracle-vm";
import plan from "../../workers/vm-launcher/src/launch.json";
import { launchOnce, signedHeaders, signingString, type Env, type Launch } from "../../workers/vm-launcher/src/lib";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = (type: "pkcs8" | "pkcs1"): Env => ({ OCI_USER: "usr", OCI_FINGERPRINT: "aa:bb", OCI_PRIVATE_KEY: privateKey.export({ type, format: "pem" }).toString() });
const launch: Launch = { tenancy: "ten", region: "eu-paris-1", compartmentId: "ocid1.compartment.oc1..c", displayName: "joutiya-vm", request: { displayName: "joutiya-vm" }, shapes: [{ ocpus: 2, memoryInGBs: 12 }, SMALL_SHAPE_CONFIG] };

describe("vm-launcher signing", () => {
  it("signs x-date, target, host and the body headers with a PKCS#8 or PKCS#1 key", async () => {
    const url = new URL("https://iaas.eu-paris-1.oraclecloud.com/20160918/instances");
    const body = new TextEncoder().encode(JSON.stringify({ displayName: "joutiya-vm" }));
    for (const type of ["pkcs8", "pkcs1"] as const) {
      const headers = await signedHeaders(env(type), "ten", "POST", url, body, new Date("2026-10-19T00:00:00Z"));
      // Left to fetch, which sends the signed values.
      expect(Object.keys(headers)).toEqual(["x-date", "content-type", "x-content-sha256", "authorization"]);
      expect(headers.authorization).toContain('keyId="ten/usr/aa:bb",algorithm="rsa-sha256",headers="x-date (request-target) host content-length content-type x-content-sha256"');
      const { text } = signingString("POST", url, { ...headers, host: url.host, "content-length": String(body.byteLength) });
      const signature = /signature="([^"]+)"/.exec(headers.authorization ?? "")?.[1] ?? "";
      expect(createVerify("RSA-SHA256").update(text).verify(publicKey, signature, "base64")).toBe(true);
    }
  });
});

describe("vm-launcher run", () => {
  const run = async (instances: object[], minute: number, launched: Response = Response.json({ id: "ocid1.instance.new", lifecycleState: "PROVISIONING" }), more = false) => {
    const posts: unknown[] = [];
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      if (init.method === "GET") {
        expect(url).toBe("https://iaas.eu-paris-1.oraclecloud.com/20160918/instances?compartmentId=ocid1.compartment.oc1..c&limit=100");
        return Response.json(instances, { headers: more ? { "opc-next-page": "p2" } : {} });
      }
      posts.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)));
      return launched;
    };
    const line = await launchOnce(launch, env("pkcs8"), minute * 60_000, fetcher);
    return { line, posts };
  };

  it("launches nothing while the compartment holds a live instance, or when the list has more pages", async () => {
    expect(await run([{ displayName: "joutiya-vm", lifecycleState: "PROVISIONING" }], 0)).toEqual({ line: "instance present (joutiya-vm PROVISIONING): nothing launched", posts: [] });
    expect((await run([], 0, undefined, true)).posts).toEqual([]);
  });

  it("launches with this minute's shape when every instance is gone", async () => {
    const even = await run([{ displayName: "joutiya-vm", lifecycleState: "TERMINATED" }], 10);
    expect(even.posts).toEqual([{ displayName: "joutiya-vm", shapeConfig: { ocpus: 2, memoryInGBs: 12 } }]);
    expect(even.line).toBe("launched joutiya-vm PROVISIONING (2 OCPU, 12 GB, ocid1.instance.new)");
    expect((await run([], 11)).posts).toEqual([{ displayName: "joutiya-vm", shapeConfig: SMALL_SHAPE_CONFIG }]);
  });

  it("logs Oracle's answer when the launch fails", async () => {
    const full = Response.json({ code: "InternalError", message: "Out of host capacity." }, { status: 500 });
    expect((await run([], 0, full)).line).toBe("no launch (2 OCPU, 12 GB): HTTP 500 InternalError Out of host capacity.");
  });
});

describe("vm-launcher launch.json", () => {
  const file = plan as Launch;
  const script = gunzipSync(Buffer.from((file.request.metadata as { user_data: string }).user_data, "base64")).toString("utf8");

  it("targets the registry's tenancy, region and compartment with both shapes and no SSH key", () => {
    const { tenancyId, homeRegion, compartmentId } = registry.shared.oracle;
    expect([file.tenancy, file.region, file.compartmentId, file.displayName]).toEqual([tenancyId, homeRegion, compartmentId, "joutiya-vm"]);
    expect(file.request).toMatchObject({ compartmentId, displayName: "joutiya-vm", shape: SHAPE.shape });
    expect(file.request).not.toHaveProperty("shapeConfig");
    expect(Object.keys(file.request.metadata as object)).toEqual(["user_data"]);
    expect(file.shapes).toEqual([{ ocpus: 2, memoryInGBs: 12 }, SMALL_SHAPE_CONFIG]);
  });

  it("carries the current bootstrap.sh with no tunnel token (rerun `node scripts/oracle-vm.ts launcher` after a change)", () => {
    for (const name of ["SSH", "STAGING", "PROD"]) expect(script).toContain(`\n${name}_TUNNEL_TOKEN='none'\n`);
    const template = script
      .replace(/^(SSH|STAGING|PROD)_TUNNEL_TOKEN='none'$/gm, "$1_TUNNEL_TOKEN='__JOUTIYA_$1_TUNNEL_TOKEN__'")
      .replace(/^VM_FILES='[A-Za-z0-9+/=]+'$/m, "VM_FILES='__JOUTIYA_VM_FILES__'");
    expect(template).toBe(readFileSync(new URL("../../infra/vm/bootstrap.sh", import.meta.url), "utf8"));
  });

  it("gives a VM created in the console the same first boot, small enough for its metadata", () => {
    const path = new URL("../../workers/vm-launcher/console-cloud-init.sh", import.meta.url);
    // consoleCloudInit throws past OCI's 32,000 bytes once base64-encoded.
    expect(readFileSync(path, "utf8")).toBe(consoleCloudInit((file.request.metadata as { user_data: string }).user_data));
    expect(spawnSync("bash", ["-n", path.pathname]).status).toBe(0);
  });
});
