import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type SealedTarget, parseSealed, seal, sealedHeader } from "../../scripts/seal-env";
import { envPayload } from "../../scripts/vm-env";
import { DAEMON_JSON, RUNNER, SECRET_FILES, deployScript, envScript, runScript, setupScript, statusScript, stopScript, wslArgs } from "../../scripts/wsl-staging";

const local = { file: "/bin/bash", args: ["-c", RUNNER] };

describe("wsl-staging runner", () => {
  it("hands wsl.exe the runner as one argument with no double quote", () => {
    expect(wslArgs()).toEqual(["-d", "joutiya-staging", "-u", "root", "--exec", "/bin/bash", "-c", RUNNER]);
    expect(RUNNER).not.toContain('"');
  });

  it("runs the script from a file with strict options, so that no command can read the rest of it", async () => {
    await expect(runScript("cat\necho after", local, false)).resolves.toBe("after\n");
    await expect(runScript("echo first\nexit 3\necho never", local, false)).rejects.toThrow(/^exit 3$/);
    await expect(runScript("false\necho never", local, false)).rejects.toThrow(/^exit 1$/);
    await expect(runScript('echo "$unset_variable"', local, false)).rejects.toThrow(/^exit 1$/);
    await expect(runScript("false | true\necho never", local, false)).rejects.toThrow(/^exit 1$/);
  });
});

describe("wsl-staging scripts", () => {
  it("are valid bash", () => {
    for (const script of [setupScript(), deployScript(), deployScript("baedebbb06f1"), statusScript(), stopScript()]) {
      expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    }
  });

  it("set up Docker and the staging group as the VM does", () => {
    expect(readFileSync("infra/vm/bootstrap.sh", "utf8")).toContain(DAEMON_JSON);
    expect(readFileSync("infra/vm/install.sh", "utf8")).toContain("ensure_group joutiya-staging 2002");
    expect(readFileSync("docker/compose.staging.yml", "utf8")).toContain('user: "1000:2002"');
    expect(setupScript()).toContain("groupadd --gid 2002 joutiya-staging");
  });

  it("keep Windows programs out of reach of the distro, at every boot and before each deploy", () => {
    for (const script of [setupScript(), deployScript()]) {
      expect(script).toContain("/usr/local/sbin/joutiya-no-interop");
      expect(script).toContain("compgen -G '/proc/sys/fs/binfmt_misc/WSLInterop*'");
    }
    expect(setupScript()).toContain("systemctl enable --quiet joutiya-no-interop.service");
  });

  it("deploy the VM's files from a commit of origin/main, and start only with every secret in place", () => {
    expect(() => deployScript("main; reboot")).toThrow(/commit SHA/);
    const script = deployScript();
    const install = readFileSync("infra/vm/install.sh", "utf8");
    for (const target of ["/usr/local/sbin/joutiya-deploy", "/usr/local/sbin/joutiya-search-setup", "/opt/joutiya/docker/valkey/"]) {
      expect(install).toContain(target);
      expect(script).toContain(target);
    }
    expect(script).toContain('merge-base --is-ancestor "$commit" origin/main');
    for (const file of SECRET_FILES) expect(script).toContain(file);
    expect(script).toContain('SSH_ORIGINAL_COMMAND="load $release" /usr/local/sbin/joutiya-deploy staging');
  });
});

describe("wsl-staging env", () => {
  const root = mkdtempSync(join(tmpdir(), "wsl-env-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const etc = join(root, "etc");
  const dir = join(etc, "staging");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pair = (name: string, out: string): string => {
    expect(spawnSync("openssl", ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", `${out}.key`]).status).toBe(0);
    expect(spawnSync("openssl", ["req", "-x509", "-new", "-key", `${out}.key`, "-subj", `/CN=${name}`, "-days", "1", "-out", `${out}.pem`]).status).toBe(0);
    return readFileSync(`${out}.pem`, "utf8");
  };
  const pem = pair("joutiya-staging-transfer", join(dir, "transfer"));
  const otherPem = pair("other", join(root, "other"));
  const sealed = (target: SealedTarget, body: string, recipient = pem) =>
    parseSealed(`${sealedHeader("staging", target)}\n${seal(`${sealedHeader("staging", target)}\n${body}`, recipient)}`);
  const run = (files: Parameters<typeof envScript>[0]) => spawnSync("bash", ["-euo", "pipefail"], { input: envScript(files, etc), encoding: "utf8" });
  const token = `TUNNEL_TOKEN=${"eyJhIjoi".repeat(6)}\n`;
  const app = sealed("app.env", envPayload({ SITE_URL: "https://staging.joutiya.ma", TURNSTILE_SECRET_KEY: "sealed $secret #1" }));

  it("opens the files with the distro's key, merges app.env as on the VM and writes tunnel.env, printing names only", () => {
    const first = run([app, sealed("tunnel.env", token), sealed("app.env", envPayload({ SITE_URL: "https://staging.joutiya.ma", HASH_PEPPER: "p".repeat(64) }))]);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const merged = readFileSync(join(dir, "app.env"), "utf8");
    expect(merged).toContain("TURNSTILE_SECRET_KEY='sealed $secret #1'\n");
    expect(merged.match(/^SITE_URL=/gm)).toHaveLength(1);
    expect(merged).toMatch(/^QUEUE_REDIS_URL='redis:\/\/:[0-9a-f]{64}@valkey-queue:6379'$/m);
    expect(readFileSync(join(dir, "tunnel.env"), "utf8")).toBe(token);
    expect(first.stdout).toContain("tunnel.env written");
    expect(first.stdout).toMatch(/^missing: .*TELEGRAM_BOT_TOKEN/m);
    expect(first.stdout).not.toMatch(/secret|ppp|eyJhIjoi/);
    expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);
    const csrf = /^CSRF_SECRET=.*$/m.exec(merged)?.[0];
    expect(run([app]).status).toBe(0);
    expect(/^CSRF_SECRET=.*$/m.exec(readFileSync(join(dir, "app.env"), "utf8"))?.[0]).toBe(csrf);
  });

  it("refuses a file sealed for another key, a relabelled one, two values for a name and another environment", () => {
    expect(run([sealed("app.env", "A='1'\n", otherPem)]).stderr).toContain("not sealed for this distro");
    expect(run([{ ...app, target: "tunnel.env" }]).stderr).toContain("its label does not match its content");
    expect(run([app, sealed("app.env", envPayload({ SITE_URL: "https://other.example" }))]).stderr).toContain("sealed files disagree on: SITE_URL");
    expect(run([sealed("tunnel.env", "TUNNEL_TOKEN=short\n")]).stderr).toContain("not a tunnel token");
    expect(() => envScript([{ ...app, env: "prod" }], etc)).toThrow("staging only");
    expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);
  });
});
