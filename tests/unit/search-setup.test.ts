import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { searchSetupScript } from "../../scripts/oracle-vm";

const SCRIPT = new URL("../../infra/vm/search-setup.sh", import.meta.url).pathname;
const MASTER = "f".repeat(64);

describe("infra/vm/search-setup.sh", () => {
  const work = mkdtempSync(join(tmpdir(), "joutiya-search-setup-"));
  const etc = join(work, "etc");
  const state = join(work, "state");
  const appEnv = join(etc, "staging", "app.env");
  const calls = join(work, "calls.log");
  // docker stub: logs its arguments and the master key's length; `compose run` writes the keys into
  // the directory mounted on /out, as scripts/search-setup.ts does.
  writeFileSync(
    join(work, "docker"),
    [
      "#!/bin/bash",
      'echo "$* master=${#MEILI_MASTER_KEY}" >> "$CALLS"',
      'if [[ " $* " == *" run "* ]]; then',
      '  for arg in "$@"; do if [[ "$arg" == *:/out ]]; then out="${arg%:/out}"; fi; done',
      '  if [[ "$STUB_KEYS" == good ]]; then printf "MEILI_SEARCH_KEY=s3arch\\nMEILI_INDEX_KEY=ind3x\\n" > "$out/keys.env"; else printf "MEILI_SEARCH_KEY=bad value\\n" > "$out/keys.env"; fi',
      "fi",
    ].join("\n"),
  );
  writeFileSync(join(work, "chgrp"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(work, "docker"), 0o755);
  chmodSync(join(work, "chgrp"), 0o755);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const run = (args: string[], keys = "good") =>
    spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${work}:${process.env.PATH ?? ""}`, JOUTIYA_ETC_DIR: etc, JOUTIYA_STATE_DIR: state, CALLS: calls, STUB_KEYS: keys },
    });

  beforeEach(() => {
    rmSync(etc, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(calls, { force: true });
    mkdirSync(join(etc, "staging"), { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(appEnv, "KEEP_ME='kept'\nMEILI_URL='http://old'\nMEILI_SEARCH_KEY=old\n", { mode: 0o600 });
    writeFileSync(join(etc, "staging", "meilisearch.env"), `MEILI_MASTER_KEY=${MASTER}\n`, { mode: 0o600 });
    writeFileSync(join(state, "staging.release"), "0123456789abcdef\n");
  });

  it("writes both keys and MEILI_URL into app.env, recreates web and worker, and never prints a key", () => {
    const result = run(["staging"]);
    expect(result.status).toBe(0);
    expect(readFileSync(appEnv, "utf8")).toBe("KEEP_ME='kept'\nMEILI_SEARCH_KEY=s3arch\nMEILI_INDEX_KEY=ind3x\nMEILI_URL=http://meilisearch:7700\n");
    expect(statSync(appEnv).mode & 0o777).toBe(0o600);
    const log = readFileSync(calls, "utf8");
    expect(log).toMatch(/compose .* up -d --no-deps --wait --wait-timeout 120 meilisearch master=64/);
    expect(log).toMatch(/compose .* run --rm --no-deps -T -e MEILI_MASTER_KEY -v \S+:\/out worker node dist\/worker\/search-setup\.mjs --url http:\/\/meilisearch:7700 --write-env \/out\/keys\.env --apply master=64/);
    expect(log).toMatch(/compose .* up -d --no-deps --force-recreate --wait --wait-timeout 240 web worker/);
    expect(log).not.toContain("reindex");
    expect(log).not.toContain(MASTER);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/s3arch|ind3x|ffffffff/);
    expect(readdirSync(state)).toEqual(["staging.release"]);
  });

  it("leaves app.env as it was when the keys are unusable", () => {
    const result = run(["staging"], "bad");
    expect(result.status).not.toBe(0);
    expect(readFileSync(appEnv, "utf8")).toBe("KEEP_ME='kept'\nMEILI_URL='http://old'\nMEILI_SEARCH_KEY=old\n");
    expect(readFileSync(calls, "utf8")).not.toContain("force-recreate");
    expect(readdirSync(state)).toEqual(["staging.release"]);
    expect(readdirSync(join(etc, "staging")).sort()).toEqual(["app.env", "meilisearch.env"]);
  });

  it("rebuilds the index on request, and refuses bad arguments or a missing master key", () => {
    expect(run(["staging", "--reindex=5000"]).status).toBe(0);
    expect(readFileSync(calls, "utf8")).toMatch(/compose .* exec -T worker node dist\/worker\/reindex-search\.mjs --apply --max-reads 5000/);
    expect(run(["qa"]).status).toBe(2);
    expect(run(["staging", "--reindex=all"]).status).toBe(2);
    writeFileSync(join(etc, "staging", "meilisearch.env"), "");
    const missing = run(["prod"]);
    expect(missing.status).toBe(1);
    expect(existsSync(join(state, "prod.release"))).toBe(false);
  });

  it("is what oracle-vm.ts search-setup runs", () => {
    expect(searchSetupScript("prod")).toBe("/usr/local/sbin/joutiya-search-setup prod");
    expect(searchSetupScript("staging", "20000")).toBe("/usr/local/sbin/joutiya-search-setup staging --reindex=20000");
    expect(() => searchSetupScript("staging", "0")).toThrow("--reindex");
  });
});
