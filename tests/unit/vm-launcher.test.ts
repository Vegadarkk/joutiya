import { spawnSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import registry from "../../infra/targets.json";
import { SHAPE, SMALL_SHAPE_CONFIG, SPARE, consoleCloudInit } from "../../scripts/oracle-vm";
import plan from "../../workers/vm-launcher/src/launch.json";
import { SPARE_EVERY, launchOnce, pkcs8, signedHeaders, signingString, type Env, type Launch } from "../../workers/vm-launcher/src/lib";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = (type: "pkcs8" | "pkcs1"): Required<Env> => ({ OCI_USER: "usr", OCI_FINGERPRINT: "aa:bb", OCI_PRIVATE_KEY: privateKey.export({ type, format: "pem" }).toString() });
const A1 = "VM.Standard.A1.Flex";
const MICRO = "VM.Standard.E2.1.Micro";
const launch: Launch = {
  tenancy: "ten",
  region: "eu-paris-1",
  compartmentId: "ocid1.compartment.oc1..c",
  displayName: "joutiya-vm",
  request: { displayName: "joutiya-vm", shape: A1 },
  shapes: [{ ocpus: 2, memoryInGBs: 12 }, SMALL_SHAPE_CONFIG],
  spare: { names: ["spare-micro-1", "spare-micro-2"], request: { shape: MICRO, createVnicDetails: { subnetId: "sub" } } },
};
const vm = (displayName: string, shape: string, lifecycleState = "RUNNING") => ({ displayName, shape, lifecycleState });
const micro = (name: string) => ({ shape: MICRO, displayName: name, createVnicDetails: { subnetId: "sub", displayName: name, hostnameLabel: name } });

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

describe("vm-launcher key parsing", () => {
  const der = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));
  const pem = env("pkcs8").OCI_PRIVATE_KEY;

  it("reads only the PEM block, whatever the console file or a Windows copy adds around it", () => {
    const crlf = pem.replaceAll("\n", "\r\n");
    for (const variant of [
      `${pem}OCI_API_KEY\n`,
      `\uFEFF${crlf}OCI_API_KEY\r\n`,
      [...`\uFEFF${crlf}`].join("\0"),
      pem.replaceAll("\n", "\\n"),
      `"${pem.trim()}"`,
    ]) {
      expect(pkcs8(variant)).toEqual(der);
    }
  });

  it("names the secret without quoting it when the key is missing or broken", async () => {
    expect(() => pkcs8(pem.split("\n").slice(1, -2).join(""))).toThrow(/^OCI_PRIVATE_KEY holds no PEM private key block$/);
    expect(() => pkcs8(pem.replace(/\n[\s\S]+\n(?=-----END)/, "\nabcde\n"))).toThrow(/^OCI_PRIVATE_KEY: the PEM block is not base64$/);
    const broken = { ...env("pkcs8"), OCI_PRIVATE_KEY: pem.replace(/\n[A-Za-z0-9+/]{8}/, "\n") };
    await expect(signedHeaders(broken, "ten", "GET", new URL("https://iaas.eu-paris-1.oraclecloud.com/"), undefined, new Date())).rejects.toThrow(/^OCI_PRIVATE_KEY is not an RSA private key$/);
  });

  it("logs which secrets are missing instead of calling Oracle", async () => {
    const fetcher = async (): Promise<Response> => {
      throw new Error("no request expected");
    };
    expect(await launchOnce(launch, { OCI_USER: "usr" }, 0, fetcher)).toBe("secrets missing: OCI_FINGERPRINT, OCI_PRIVATE_KEY");
  });
});

describe("vm-launcher run", () => {
  const run = async (instances: object[], minute: number, launched: Response = Response.json({ id: "ocid1.instance.new", lifecycleState: "PROVISIONING" }), more = false, plan: Launch = launch) => {
    const posts: unknown[] = [];
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      if (init.method === "GET") {
        expect(url).toBe("https://iaas.eu-paris-1.oraclecloud.com/20160918/instances?compartmentId=ocid1.compartment.oc1..c&limit=100");
        return Response.json(instances, { headers: more ? { "opc-next-page": "p2" } : {} });
      }
      posts.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)));
      return launched;
    };
    const line = await launchOnce(plan, env("pkcs8"), minute * 60_000, fetcher);
    return { line, posts };
  };

  it("launches nothing once joutiya-vm and both spares live, or when the list has more pages", async () => {
    const all = [vm("joutiya-vm", A1, "PROVISIONING"), vm("spare-micro-1", MICRO), vm("spare-micro-2", MICRO)];
    expect(await run(all, 0)).toEqual({ line: "instances present (joutiya-vm PROVISIONING, spare-micro-1 RUNNING, spare-micro-2 RUNNING): nothing launched", posts: [] });
    expect(await run([], 0, undefined, true)).toEqual({ line: "instance list has more than one page: nothing launched", posts: [] });
  });

  it("never launches a second A1 VM, whatever the first one is called", async () => {
    const { spare: _spare, ...withoutSpare } = launch;
    expect((await run([vm("renamed-by-hand", A1)], 0, undefined, false, withoutSpare)).posts).toEqual([]);
    expect((await run([vm("joutiya-vm", A1)], 1, undefined, false, withoutSpare)).posts).toEqual([]);
  });

  it("launches joutiya-vm with this minute's shape when every instance is gone", async () => {
    const even = await run([vm("joutiya-vm", A1, "TERMINATED")], 10);
    expect(even.posts).toEqual([{ displayName: "joutiya-vm", shape: A1, shapeConfig: { ocpus: 2, memoryInGBs: 12 } }]);
    expect(even.line).toBe("launched joutiya-vm PROVISIONING (2 OCPU, 12 GB, ocid1.instance.new)");
    expect((await run([], 9)).posts).toEqual([{ displayName: "joutiya-vm", shape: A1, shapeConfig: SMALL_SHAPE_CONFIG }]);
  });

  it("gives one minute in SPARE_EVERY to a spare while joutiya-vm is missing, every minute once it lives", async () => {
    const minutes = Array.from({ length: SPARE_EVERY * 2 }, (_, minute) => minute);
    const missing = await Promise.all(minutes.map(async (minute) => ((await run([], minute)).posts[0] as { shape: string }).shape));
    expect(missing.filter((shape) => shape === MICRO)).toHaveLength(2);
    const live = await run([vm("joutiya-vm", A1)], 0);
    expect(live.posts).toEqual([micro("spare-micro-1")]);
    expect(live.line).toBe(`launched spare-micro-1 PROVISIONING (${MICRO}, ocid1.instance.new)`);
  });

  it("names a spare after the first free name and stops at as many spares as names", async () => {
    expect((await run([vm("joutiya-vm", A1), vm("spare-micro-1", MICRO)], 0)).posts).toEqual([micro("spare-micro-2")]);
    expect((await run([vm("joutiya-vm", A1), vm("spare-micro-2", MICRO, "STOPPED")], 0)).posts).toEqual([micro("spare-micro-1")]);
    expect((await run([vm("joutiya-vm", A1), vm("other", MICRO), vm("spare-micro-1", MICRO)], 0)).posts).toEqual([]);
    const full = Response.json({ code: "QuotaExceeded", message: "standard-e2-micro-core-count" }, { status: 400 });
    expect((await run([vm("joutiya-vm", A1)], 0, full)).line).toBe("no launch (spare-micro-1): HTTP 400 QuotaExceeded standard-e2-micro-core-count");
  });

  it("logs Oracle's answer when the launch fails", async () => {
    const full = Response.json({ code: "InternalError", message: "Out of host capacity." }, { status: 500 });
    expect((await run([vm("spare-micro-1", MICRO), vm("spare-micro-2", MICRO)], 0, full)).line).toBe("no launch (2 OCPU, 12 GB): HTTP 500 InternalError Out of host capacity.");
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

  it("asks for the free Micro spares under neutral names, with no user data and within 200 GB of boot volumes", () => {
    const spare = file.spare;
    expect(spare?.names).toEqual([...SPARE.names]);
    expect(spare?.request).toMatchObject({ compartmentId: registry.shared.oracle.compartmentId, shape: SPARE.shape, freeformTags: { role: "spare" } });
    expect(spare?.request).not.toHaveProperty("metadata");
    expect(spare?.request).not.toHaveProperty("displayName");
    expect(JSON.stringify(spare)).not.toMatch(/joutiya-/);
    const boot = (request: Record<string, unknown>) => (request.sourceDetails as { bootVolumeSizeInGBs: number }).bootVolumeSizeInGBs;
    expect(boot(file.request) + (spare?.names.length ?? 0) * boot(spare?.request ?? {})).toBeLessThanOrEqual(200);
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
