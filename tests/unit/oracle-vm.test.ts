import { spawnSync } from "node:child_process";
import { X509Certificate, createHash, generateKeyPairSync, createVerify, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { parseSealed, seal, sealedHeader } from "../../scripts/seal-env";
import { envPayload } from "../../scripts/vm-env";
import {
  MAX_METADATA_BYTES,
  NAMES,
  OciError,
  RUN_COMMAND_MAX_BYTES,
  SHAPE,
  SMALL_SHAPE_CONFIG,
  bootstrapLines,
  buildUserData,
  deployScript,
  deployStagingKey,
  isCapacityError,
  isTransientError,
  launchDetails,
  parseStatus,
  pickImage,
  promoteCommand,
  rebuildDetails,
  recordedTarballs,
  buildStagingScript,
  rootCommand,
  sealedEnvScripts,
  transferScript,
  transferSliceScript,
  securityList,
  shapeForAttempt,
  signedHeaders,
  signingString,
  syncCommands,
  tunnelsScript,
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

  it("alternates with the half-size free shape only when asked to", () => {
    expect([1, 2, 3, 4].map((attempt) => shapeForAttempt(attempt, false))).toEqual(Array(4).fill({ ocpus: 2, memoryInGBs: 12 }));
    expect([1, 2, 3, 4].map((attempt) => shapeForAttempt(attempt, true).ocpus)).toEqual([2, 1, 2, 1]);
    expect(SMALL_SHAPE_CONFIG.ocpus * 6).toBe(SMALL_SHAPE_CONFIG.memoryInGBs);
    const details = launchDetails({ availabilityDomain: "AD-1", compartmentId: "c", subnetId: "s", imageId: "i", userData: "u", shapeConfig: SMALL_SHAPE_CONFIG });
    expect(details).toMatchObject({ shape: "VM.Standard.A1.Flex", shapeConfig: { ocpus: 1, memoryInGBs: 6 } });
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
    const x86 = [image("Canonical-Ubuntu-24.04-2026.09.18-0"), image("Canonical-Ubuntu-24.04-aarch64-2026.09.30-0"), image("Canonical-Ubuntu-24.04-Minimal-2026.09.30-0")];
    expect(pickImage(x86, "x86_64").displayName).toBe("Canonical-Ubuntu-24.04-2026.09.18-0");
  });

  it("retries on missing A1 capacity only", () => {
    expect(isCapacityError(new OciError(500, "InternalError", "Out of host capacity."))).toBe(true);
    expect(isCapacityError(new OciError(429, "TooManyRequests", "slow down"))).toBe(true);
    expect(isCapacityError(new OciError(400, "LimitExceeded", "quota"))).toBe(false);
    expect(isCapacityError(new Error("Out of host capacity"))).toBe(false);
  });

  it("also retries OCI server and network errors, never a client error", () => {
    expect(isTransientError(new OciError(502, "", "Bad Gateway"))).toBe(true);
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientError(new OciError(400, "LimitExceeded", "quota"))).toBe(false);
    expect(isTransientError(new OciError(401, "NotAuthenticated", "signature"))).toBe(false);
    expect(isTransientError(new Error("boom"))).toBe(false);
  });

  it("reads the bootstrap progress from the serial console", () => {
    const console = "[  12.1] cloud-init[812]: noise\r\n[  30.2] joutiya-bootstrap: ssh tunnel installed\r\nCloud-init v. 25.1 finished at Fri, 16 Oct 2026. Up 300 seconds\r\n";
    expect(bootstrapLines(console)).toEqual(["joutiya-bootstrap: ssh tunnel installed", "Cloud-init v. 25.1 finished at Fri, 16 Oct 2026. Up 300 seconds"]);
  });
});

describe("rebuild", () => {
  it("replaces the boot volume and the user data together, keeping any SSH key", () => {
    const details = rebuildDetails({ imageId: "ocid1.image.oc1.x", userData: "bmV3", metadata: { user_data: "b2xk", ssh_authorized_keys: "ssh-ed25519 AAAA" }, keepDisk: false });
    expect(details).toEqual({
      metadata: { user_data: "bmV3", ssh_authorized_keys: "ssh-ed25519 AAAA" },
      sourceDetails: { sourceType: "image", imageId: "ocid1.image.oc1.x", bootVolumeSizeInGBs: 100, isPreserveBootVolumeEnabled: false },
    });
    expect(rebuildDetails({ imageId: "i", userData: "bmV3", keepDisk: true })).toMatchObject({ metadata: { user_data: "bmV3" }, sourceDetails: { isPreserveBootVolumeEnabled: true } });
  });
});

describe("OCI Run Command", () => {
  // The commands run here as the test user: a sudo stub drops -n and runs the rest.
  const work = mkdtempSync(join(tmpdir(), "joutiya-run-command-"));
  writeFileSync(join(work, "sudo"), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n');
  chmodSync(join(work, "sudo"), 0o755);
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const runText = (text: string) => {
    writeFileSync(join(work, "command.sh"), text);
    return spawnSync("bash", [join(work, "command.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${work}:${process.env.PATH ?? ""}` }, input: "never read\n" });
  };
  const bundleOf = (files: Record<string, string>): string => {
    const source = mkdtempSync(join(work, "source-"));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(source, name, ".."), { recursive: true });
      writeFileSync(join(source, name), content);
    }
    return spawnSync("tar", ["-czf", "-", "-C", source, "infra"]).stdout.toString("base64");
  };

  it("runs a root script in strict mode with stdin closed and keeps its exit code", () => {
    const ok = runText(rootCommand('echo "$(cat)" done\nfalse || echo recovered'));
    expect([ok.status, ok.stdout]).toEqual([0, " done\nrecovered\n"]);
    const failed = runText(rootCommand("echo before\nfalse\necho after"));
    expect([failed.status, failed.stdout]).toEqual([1, "before\n"]);
  });

  it("refuses its end marker and a script over the Run Command limit", () => {
    expect(() => rootCommand("echo a\nJOUTIYA_ROOT_SCRIPT\necho b")).toThrow("a line of the script");
    expect(() => rootCommand("#".repeat(RUN_COMMAND_MAX_BYTES))).toThrow("Run Command allows");
  });

  it("syncs a bundle in chunks, checks it, runs its install.sh and cleans up", () => {
    const bundle = bundleOf({ "infra/vm/install.sh": 'echo "install: $(ls "$1")"\n', "infra/vm/noise": randomBytes(6_000).toString("hex") });
    const dir = join(work, "sync");
    const commands = syncCommands(bundle, dir, 3_000);
    expect(commands.length).toBeGreaterThan(3);
    for (const text of commands.slice(0, -1)) expect(runText(text).status).toBe(0);
    expect(readFileSync(join(dir, "bundle.b64"), "utf8")).toBe(bundle);
    const install = runText(commands.at(-1) ?? "");
    expect([install.status, install.stdout]).toEqual([0, "install: infra\n"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("installs nothing when a chunk is missing", () => {
    const bundle = bundleOf({ "infra/vm/install.sh": "echo installed\n", "infra/vm/noise": randomBytes(6_000).toString("hex") });
    const commands = syncCommands(bundle, join(work, "partial"), 3_000);
    expect(runText(commands[0] ?? "").status).toBe(0);
    const install = runText(commands.at(-1) ?? "");
    expect(install.status).not.toBe(0);
    expect(install.stdout).not.toContain("installed");
    expect(() => syncCommands("not base64!")).toThrow("not base64");
  });
  it("writes the tunnel tokens of a launcher VM root-only, then starts the SSH tunnel", () => {
    const script = tunnelsScript({ ssh: token("ssh"), staging: token("staging"), prod: token("prod") });
    const lines = script.split("\n");
    expect(lines.indexOf("umask 077")).toBeLessThan(lines.findIndex((line) => line.startsWith("printf")));
    expect(lines).toContain(`printf 'TUNNEL_TOKEN=%s\\n' '${token("prod")}' > /etc/joutiya/prod/tunnel.env`);
    expect(lines.slice(-3, -1)).toEqual(["systemctl enable cloudflared.service", "systemctl restart cloudflared.service"]);
    expect(() => rootCommand(script)).not.toThrow();
    expect(() => tunnelsScript({ ssh: "none", staging: token("staging"), prod: token("prod") })).toThrow("joutiya-ssh-tunnel");
    expect(() => tunnelsScript({ ssh: token("ssh"), staging: "x' y", prod: token("prod") })).toThrow("joutiya-staging-tunnel");
  });
});

describe("production releases", () => {
  const id = (digit: string) => `sha256:${digit.repeat(64)}`;

  it("parses the VM status", () => {
    const text = JSON.stringify({ staging: { release: "0123456789ab", web: id("a"), worker: id("b") }, prod: { release: "", web: "", worker: "" } });
    expect(parseStatus(text).staging.release).toBe("0123456789ab");
    expect(() => parseStatus('{"staging":{}}')).toThrow(/staging is missing/);
  });

  it("trusts only the tarballs GitHub Actions recorded on the release's commit", () => {
    const sha = "0123456789ab".padEnd(40, "c");
    const run = { name: "Release images", head_sha: sha, conclusion: "success", app: { slug: "github-actions" }, output: { summary: `tarball ${id("d")}` } };
    const answer = {
      check_runs: [
        run,
        { ...run, app: { slug: "some-app" }, output: { summary: `tarball ${id("e")}` } },
        { ...run, conclusion: "failure", output: { summary: `tarball ${id("f")}` } },
        { ...run, head_sha: "f".repeat(40), output: { summary: `tarball ${id("1")}` } },
        { ...run, name: "Dependabot", output: { summary: null } },
      ],
    };
    expect(recordedTarballs(answer, "0123456789ab")).toEqual([id("d")]);
    expect(recordedTarballs({ check_runs: [] }, "0123456789ab")).toEqual([]);
    expect(() => recordedTarballs({ message: "Not Found" }, "0123456789ab")).toThrow("unexpected answer");
  });

  it("promotes only a valid release with both image IDs", () => {
    expect(promoteCommand({ release: "0123456789ab", web: id("a"), worker: id("b") })).toBe(`promote 0123456789ab ${id("a")} ${id("b")}`);
    expect(() => promoteCommand({ release: "", web: id("a"), worker: id("b") })).toThrow(/no valid release/);
    expect(() => promoteCommand({ release: "0123456789ab; rm -rf /", web: id("a"), worker: id("b") })).toThrow(/no valid release/);
    expect(() => promoteCommand({ release: "0123456789ab", web: "", worker: id("b") })).toThrow(/image IDs/);
  });

  it("sends the forced command of production one request it cannot be tricked by", () => {
    expect(deployScript("status")).toBe("SSH_ORIGINAL_COMMAND='status' /usr/local/sbin/joutiya-deploy prod");
    expect(deployScript(promoteCommand({ release: "0123456789ab", web: id("a"), worker: id("b") }))).toContain(`'promote 0123456789ab ${id("a")} ${id("b")}'`);
    expect(() => deployScript("status'; reboot; '")).toThrow("invalid deploy request");
  });
});

describe("CI deploy key", () => {
  it("accepts one ed25519 public key only", () => {
    const key = `ssh-ed25519 ${Buffer.from(randomBytes(51)).toString("base64")} joutiya-ci`;
    expect(deployStagingKey(`${key}\n\n`)).toBe(`${key}\n`);
    expect(() => deployStagingKey(`${key}\n${key}`)).toThrow("one ssh-ed25519");
    expect(() => deployStagingKey(`command="sh" ${key}`)).toThrow("one ssh-ed25519");
    expect(() => deployStagingKey("ssh-rsa AAAAB3NzaC1yc2E joutiya-ci")).toThrow("one ssh-ed25519");
  });
});

describe("transfer and sealed env", () => {
  const root = mkdtempSync(join(tmpdir(), "vm-sealed-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { etc: join(root, "etc"), stage: join(root, "stage") };
  mkdirSync(join(dirs.etc, "prod"), { recursive: true, mode: 0o700 });
  const bash = (script: string) => spawnSync("bash", ["-euo", "pipefail"], { input: script, encoding: "utf8" });
  /** The commands in order, as Run Command sends them: the first failure stops the rest. */
  const runAll = (commands: string[]) => {
    let last = bash("true");
    for (const command of commands) {
      last = bash(command);
      if (last.status !== 0) break;
    }
    return last;
  };

  it("makes the transfer key pair once and reads its certificate back in slices", () => {
    const first = bash(transferScript(dirs.etc));
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("transfer key made");
    const length = Number(/^transfer-length (\d+)$/m.exec(first.stdout)?.[1]);
    const again = bash(transferScript(dirs.etc));
    expect(again.stdout).not.toContain("transfer key made");
    let base64 = "";
    for (let from = 1; from <= length; from += 900) base64 += /^slice (\S*)$/m.exec(bash(transferSliceScript(from, from + 899, dirs.etc)).stdout)?.[1] ?? "";
    expect(createHash("sha256").update(base64).digest("hex")).toBe(/^transfer-sha256 (\S+)$/m.exec(again.stdout)?.[1]);
    expect(new X509Certificate(Buffer.from(base64, "base64")).subject).toBe("CN=joutiya-vm-transfer");
    expect(transferScript().length + 300).toBeLessThan(RUN_COMMAND_MAX_BYTES);
  }, 60_000);

  it("opens app.env sealed for the VM and merges it, printing names only; refuses other keys and environments", () => {
    const pem = readFileSync(join(dirs.etc, "transfer.pem"), "utf8");
    const other = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/dev/null", "-subj", "/CN=other", "-days", "1"], { encoding: "utf8" }).stdout;
    const sealed = (body: string, recipient = pem) => parseSealed(`${sealedHeader("prod", "app.env")}\n${seal(`${sealedHeader("prod", "app.env")}\n${body}`, recipient)}`);
    const app = sealed(envPayload({ SITE_URL: "https://joutiya.ma", TURNSTILE_SECRET_KEY: "sealed $secret #1" }));
    const commands = sealedEnvScripts("prod", [app, sealed(envPayload({ HASH_PEPPER: "p".repeat(64) }))], dirs, 500);
    expect(commands.length).toBeGreaterThan(3);
    for (const command of commands) expect(Buffer.byteLength(rootCommand(command))).toBeLessThanOrEqual(RUN_COMMAND_MAX_BYTES);
    const last = runAll(commands);
    expect(last.stderr).toBe("");
    expect(last.status).toBe(0);
    const merged = readFileSync(join(dirs.etc, "prod", "app.env"), "utf8");
    expect(merged).toContain("TURNSTILE_SECRET_KEY='sealed $secret #1'\n");
    expect(merged).toMatch(/^HASH_PEPPER='p{64}'$/m);
    expect(last.stdout).not.toMatch(/secret|ppp/);
    expect(existsSync(join(dirs.stage, "prod.sealed.1"))).toBe(false);
    const scripts = (files: Parameters<typeof sealedEnvScripts>[1]) => sealedEnvScripts("prod", files, dirs);
    expect(runAll(scripts([sealed("A='1'\n", other)])).stderr).toContain("not sealed for this VM");
    expect(readdirSync(dirs.stage)).toEqual([]);
    expect(runAll(scripts([app, sealed(envPayload({ SITE_URL: "https://other.example" }))])).stderr).toContain("sealed files disagree on: SITE_URL");
    expect(readdirSync(dirs.stage)).toEqual([]);
    expect(() => sealedEnvScripts("staging", [app], dirs)).toThrow("is for prod, not staging");
    expect(() => sealedEnvScripts("prod", [{ ...app, target: "tunnel.env" }], dirs)).toThrow("tunnels");
  });
});

describe("build-staging", () => {
  it("clones once, builds a commit of origin/main and starts it only once every secret is there", () => {
    const script = buildStagingScript("e84c7209f7bd");
    expect(Buffer.byteLength(rootCommand(script))).toBeLessThanOrEqual(RUN_COMMAND_MAX_BYTES);
    expect(script).toContain("[[ -d /opt/joutiya/src/.git ]] || git clone --quiet https://github.com/Vegadarkk/joutiya.git /opt/joutiya/src");
    expect(script).toContain("merge-base --is-ancestor");
    expect(script).toContain("/etc/joutiya/staging/app.env");
    expect(script.indexOf("the start waits for")).toBeLessThan(script.indexOf("joutiya-deploy staging"));
    expect(() => buildStagingScript("main; rm -rf /")).toThrow("--commit");
  });
});
