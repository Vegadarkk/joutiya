import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAEMON_JSON, RUNNER, SECRET_FILES, deployScript, runScript, setupScript, statusScript, stopScript, wslArgs } from "../../scripts/wsl-staging";

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
