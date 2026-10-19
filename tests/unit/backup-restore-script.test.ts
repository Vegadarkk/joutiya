import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptAge, generateIdentity, identityToRecipient } from "@/lib/backup/crypto";
import { manifestKey, partKey, sealPart } from "@/lib/backup/parts";
import { bucketConfig, parseCli, projectProblem, SPARK_DAILY_WRITES, writesProblem } from "../../scripts/restore-firestore.ts";
import type { Targets } from "../../scripts/assert-target.ts";

// scripts/restore-firestore.ts: arguments, the target guard (never production by accident), and a
// dry run under plain Node (type stripping) that prints counts, never the identity or contents.

const run = promisify(execFile);

function targets(projects: { dev?: string | null; staging?: string | null; prod?: string | null }): Targets {
  const env = (name: "dev" | "staging" | "prod") => ({
    firebase: { projectId: projects[name] ?? null, projectNumber: null, firestoreLocation: null, appId: null },
    google: { oauthClientId: null },
    turnstile: { siteKey: null },
    sentry: { dsn: null },
    r2: { quarantine: `joutiya-${name}-quarantine`, media: `joutiya-${name}-media`, private: `joutiya-${name}-private` },
    whatsapp: { wabaId: null, phoneNumberId: null },
    cloudflare: { tunnelId: null, accessAud: null },
  });
  return { shared: {} as Targets["shared"], environments: { dev: env("dev"), staging: env("staging"), prod: env("prod") } };
}

describe("parseCli", () => {
  it("reads the options, dry run by default", () => {
    expect(parseCli(["--identity", "k.txt", "--from", "dl", "--project", "joutiya-staging"])).toEqual({
      identity: "k.txt",
      from: "dl",
      fromBucket: null,
      project: "joutiya-staging",
      collections: null,
      until: null,
      apply: false,
      allowProduction: false,
      allowUnverified: false,
      allowOverQuota: false,
    });
    expect(
      parseCli(["--identity", "k", "--from-bucket", "prod", "--project", "p-123x", "--collections", "users, listings,", "--until", "2026-10-16", "--apply", "--allow-production", "--allow-unverified", "--allow-over-quota"]),
    ).toEqual({
      identity: "k",
      from: null,
      fromBucket: "prod",
      project: "p-123x",
      collections: ["users", "listings"],
      until: "2026-10-16",
      apply: true,
      allowProduction: true,
      allowUnverified: true,
      allowOverQuota: true,
    });
  });

  it("refuses incomplete or ambiguous arguments", () => {
    for (const argv of [[], ["--from", "dl", "--project", "p"], ["--identity", "k", "--project", "p"], ["--identity", "k", "--from", "dl", "--from-bucket", "--project", "p"], ["--identity", "k", "--from", "dl"], ["--identity", "k", "--from", "dl", "--project", "p", "--force"]]) {
      expect(() => parseCli(argv), argv.join(" ")).toThrow();
    }
    // The bucket of an environment whose backups exist.
    expect(() => parseCli(["--identity", "k", "--from-bucket", "dev", "--project", "p"])).toThrow(/--from-bucket: staging or prod/);
    expect(() => parseCli(["--identity", "k", "--from-bucket", "--project", "p"])).toThrow();
    expect(() => parseCli(["--identity", "k", "--from", "dl", "--project", "p", "--until", "demain"])).toThrow(/--until/);
    expect(() => parseCli(["--identity", "k", "--from", "dl", "--project", "p", "--collections", "users/u1"])).toThrow(/--collections/);
  });
});

describe("projectProblem", () => {
  const recorded = targets({ dev: "joutiya-dev", staging: "joutiya-staging", prod: "joutiya-prod" });

  it("lets the emulator take any project id", () => {
    expect(projectProblem(recorded, "demo-joutiya", { emulated: true, allowProduction: false })).toBeNull();
    expect(projectProblem(recorded, "joutiya-prod", { emulated: true, allowProduction: false })).toBeNull();
  });

  it("writes only into a recorded project, production only with --allow-production", () => {
    expect(projectProblem(recorded, "joutiya-staging", { emulated: false, allowProduction: false })).toBeNull();
    expect(projectProblem(recorded, "other-project", { emulated: false, allowProduction: true })).toMatch(/not recorded in infra\/targets\.json/);
    expect(projectProblem(recorded, "joutiya-prod", { emulated: false, allowProduction: false })).toMatch(/production project: .*--allow-production/);
    expect(projectProblem(recorded, "joutiya-prod", { emulated: false, allowProduction: true })).toBeNull();
    // Development has no worker identity to write with: its data goes to the emulator.
    expect(projectProblem(recorded, "joutiya-dev", { emulated: false, allowProduction: true })).toMatch(/no worker identity: restore into the emulator/);
    expect(projectProblem(recorded, "joutiya-dev", { emulated: true, allowProduction: false })).toBeNull();
    expect(projectProblem(targets({}), "joutiya-prod", { emulated: false, allowProduction: true })).toMatch(/not recorded/);
    expect(projectProblem(recorded, "Bad_Id", { emulated: true, allowProduction: false })).toMatch(/not a Firebase project id/);
  });
});

describe("writesProblem", () => {
  it("refuses more than Spark's daily writes into a real project, with the way to split it", () => {
    expect(SPARK_DAILY_WRITES).toBe(20_000);
    expect(writesProblem(20_000, { emulated: false, allowOverQuota: false })).toBeNull();
    const problem = writesProblem(20_001, { emulated: false, allowOverQuota: false });
    expect(problem).toMatch(/^20001 documents exceed Spark's 20000 writes a day/);
    expect(problem).toContain("--collections");
    expect(problem).toContain("--allow-over-quota");
  });

  it("lets the emulator and an explicit --allow-over-quota (Blaze) through", () => {
    expect(writesProblem(1_000_000, { emulated: true, allowOverQuota: false })).toBeNull();
    expect(writesProblem(1_000_000, { emulated: false, allowOverQuota: true })).toBeNull();
  });
});

describe("bucketConfig", () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  const recorded = { ...targets({}), shared: { cloudflare: { accountId } } as unknown as Targets["shared"] };
  // The owner's .env.local: unsuffixed names belong to development or another product.
  const vars = { R2_ACCESS_KEY_ID: "other-id", R2_SECRET_ACCESS_KEY: "other-secret", R2_ACCESS_KEY_ID_PROD: " prod-id ", R2_SECRET_ACCESS_KEY_PROD: "prod-secret" };

  it("reads the environment's own keys, bucket and endpoint from the registry", () => {
    expect(bucketConfig(recorded, "prod", vars)).toEqual({
      config: { endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com`, accessKeyId: "prod-id", secretAccessKey: "prod-secret", bucket: "joutiya-prod-private" },
      problems: [],
    });
  });

  it("never falls back to the unsuffixed keys, and names variables only", () => {
    const missing = bucketConfig(recorded, "staging", { ...vars, R2_SECRET_ACCESS_KEY_STAGING: "" });
    expect(missing).toEqual({ config: null, problems: ["--from-bucket staging needs R2_ACCESS_KEY_ID_STAGING and R2_SECRET_ACCESS_KEY_STAGING (the R2 keys of staging, as in .env.local)"] });
    for (const value of ["other-id", "other-secret", "prod-id", "prod-secret"]) expect(missing.problems.join(" ")).not.toContain(value);
    const unrecorded = bucketConfig({ ...recorded, shared: { cloudflare: { accountId: null } } as unknown as Targets["shared"] }, "prod", vars);
    expect(unrecorded).toEqual({ config: null, problems: ["shared.cloudflare.accountId is not recorded in infra/targets.json"] });
  });
});

describe("restore-firestore under plain Node", () => {
  let dir: string;
  let identity: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "joutiya-restore-"));
    identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const lines = [JSON.stringify({ p: "users/u1", d: { displayName: "Contenu privé" }, u: null }), JSON.stringify({ p: "users/u2", d: {}, u: null })];
    const part = await sealPart(lines, recipient);
    const manifest = { version: 1, date: "2026-10-16", parts: [{ key: partKey("2026-10-16", "full", "users", null), docs: part.docs, plainBytes: part.plainBytes, sha256: part.sha256 }] };
    for (const [key, body] of [
      [partKey("2026-10-16", "full", "users", null), part.body],
      [manifestKey("2026-10-16"), await encryptAge(Buffer.from(JSON.stringify(manifest)), recipient)],
    ] as const) {
      await mkdir(join(dir, "dl", key, ".."), { recursive: true });
      await writeFile(join(dir, "dl", key), body);
    }
    // Test key pair generated for this run only, removed in afterAll.
    await writeFile(join(dir, "key.txt"), `# public key: ${recipient}\n${identity}\n`);
    await chmod(join(dir, "key.txt"), 0o600);
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("checks and plans without writing, printing counts only", async () => {
    // Port 1: the dry run must not connect to anything.
    const { stdout, stderr } = await run(process.execPath, ["scripts/restore-firestore.ts", "--identity", join(dir, "key.txt"), "--from", join(dir, "dl"), "--project", "demo-joutiya"], {
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", FIRESTORE_EMULATOR_HOST: "127.0.0.1:1" },
    });
    expect(stdout).toContain("1 part(s) from 2026-10-16 to 2026-10-16; manifests checked for 1 of 1 date(s)");
    expect(stdout).toContain("2 documents to write:");
    expect(stdout).toContain("  users: 2");
    expect(stdout).toContain("Dry run: nothing written");
    expect(`${stdout}${stderr}`).not.toContain(identity);
    expect(`${stdout}${stderr}`).not.toContain("AGE-SECRET-KEY");
    expect(`${stdout}${stderr}`).not.toContain("Contenu privé");
  });

  it("refuses a damaged key file without printing it", async () => {
    const damaged = identity.slice(0, -1) + (identity.endsWith("Q") ? "P" : "Q");
    await writeFile(join(dir, "damaged.txt"), `${damaged}\n`);
    await chmod(join(dir, "damaged.txt"), 0o600);
    const failure = await run(process.execPath, ["scripts/restore-firestore.ts", "--identity", join(dir, "damaged.txt"), "--from", join(dir, "dl"), "--project", "demo-joutiya"], {
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", FIRESTORE_EMULATOR_HOST: "127.0.0.1:1" },
    }).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining("the key is damaged") });
    const output = `${(failure as { stdout: string }).stdout}${(failure as { stderr: string }).stderr}`;
    expect(output).not.toContain(damaged.slice(16, 40));
  });

  it("refuses a project that is not recorded outside the emulator", async () => {
    const failure = await run(process.execPath, ["scripts/restore-firestore.ts", "--identity", join(dir, "key.txt"), "--from", join(dir, "dl"), "--project", "some-real-project", "--apply"], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" } }).catch(
      (error: { code: number; stderr: string }) => error,
    );
    expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining("not recorded in infra/targets.json") });
  });
});
