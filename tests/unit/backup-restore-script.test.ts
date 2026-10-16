import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptAge, generateIdentity, identityToRecipient } from "@/lib/backup/crypto";
import { manifestKey, partKey, sealPart } from "@/lib/backup/parts";
import { bucketProblems, parseCli, projectProblem } from "../../scripts/restore-firestore.ts";
import type { Targets } from "../../scripts/assert-target.ts";

// scripts/restore-firestore.ts: arguments, the target guard (never production by accident), and a
// dry run under plain Node (type stripping) that prints counts, never the identity or contents.

const run = promisify(execFile);

function targets(projects: { dev?: string | null; staging?: string | null; prod?: string | null }): Targets {
  const env = (name: "dev" | "staging" | "prod") => ({
    firebase: { projectId: projects[name] ?? null, projectNumber: null, firestoreLocation: null },
    r2: { quarantine: `joutiya-${name}-quarantine`, media: `joutiya-${name}-media`, private: `joutiya-${name}-private` },
    whatsapp: { wabaId: null, phoneNumberId: null },
    cloudflare: { tunnelId: null, accessAud: null },
  });
  return { shared: {} as Targets["shared"], environments: { dev: env("dev"), staging: env("staging"), prod: env("prod") } };
}

describe("parseCli", () => {
  it("reads the options, dry run by default", () => {
    expect(parseCli(["--identity", "k.txt", "--from", "dl", "--project", "joutiya-staging"])).toEqual({ identity: "k.txt", from: "dl", fromBucket: false, project: "joutiya-staging", collections: null, until: null, apply: false, allowProduction: false });
    expect(parseCli(["--identity", "k", "--from-bucket", "--project", "p-123x", "--collections", "users, listings,", "--until", "2026-10-16", "--apply", "--allow-production"])).toEqual({
      identity: "k",
      from: null,
      fromBucket: true,
      project: "p-123x",
      collections: ["users", "listings"],
      until: "2026-10-16",
      apply: true,
      allowProduction: true,
    });
  });

  it("refuses incomplete or ambiguous arguments", () => {
    for (const argv of [[], ["--from", "dl", "--project", "p"], ["--identity", "k", "--project", "p"], ["--identity", "k", "--from", "dl", "--from-bucket", "--project", "p"], ["--identity", "k", "--from", "dl"], ["--identity", "k", "--from", "dl", "--project", "p", "--force"]]) {
      expect(() => parseCli(argv), argv.join(" ")).toThrow();
    }
    expect(() => parseCli(["--identity", "k", "--from", "dl", "--project", "p", "--until", "demain"])).toThrow(/--until/);
    expect(() => parseCli(["--identity", "k", "--from", "dl", "--project", "p", "--collections", "users/u1"])).toThrow(/--collections/);
  });
});

describe("projectProblem", () => {
  const recorded = targets({ staging: "joutiya-staging", prod: "joutiya-prod" });

  it("lets the emulator take any project id", () => {
    expect(projectProblem(recorded, "demo-joutiya", { emulated: true, allowProduction: false })).toBeNull();
    expect(projectProblem(recorded, "joutiya-prod", { emulated: true, allowProduction: false })).toBeNull();
  });

  it("writes only into a recorded project, production only with --allow-production", () => {
    expect(projectProblem(recorded, "joutiya-staging", { emulated: false, allowProduction: false })).toBeNull();
    expect(projectProblem(recorded, "other-project", { emulated: false, allowProduction: true })).toMatch(/not recorded in infra\/targets\.json/);
    expect(projectProblem(recorded, "joutiya-prod", { emulated: false, allowProduction: false })).toMatch(/production project: .*--allow-production/);
    expect(projectProblem(recorded, "joutiya-prod", { emulated: false, allowProduction: true })).toBeNull();
    expect(projectProblem(targets({}), "joutiya-prod", { emulated: false, allowProduction: true })).toMatch(/not recorded/);
    expect(projectProblem(recorded, "Bad_Id", { emulated: true, allowProduction: false })).toMatch(/not a Firebase project id/);
  });
});

describe("bucketProblems", () => {
  const recorded = targets({});
  const env = { R2_S3_ENDPOINT: "https://a.eu.r2.cloudflarestorage.com", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_PRIVATE: "joutiya-prod-private" };

  it("needs the four R2 variables and a recorded private bucket, naming variables only", () => {
    expect(bucketProblems(recorded, env)).toEqual([]);
    expect(bucketProblems(recorded, { ...env, R2_SECRET_ACCESS_KEY: undefined, R2_S3_ENDPOINT: "" })).toEqual(["--from-bucket needs R2_S3_ENDPOINT, R2_SECRET_ACCESS_KEY"]);
    const wrong = bucketProblems(recorded, { ...env, R2_BUCKET_PRIVATE: "joutiya-prod-media" });
    expect(wrong).toEqual(["R2_BUCKET_PRIVATE is not a private bucket recorded in infra/targets.json"]);
    expect(wrong.join(" ")).not.toContain("secret");
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

  it("refuses a project that is not recorded outside the emulator", async () => {
    const failure = await run(process.execPath, ["scripts/restore-firestore.ts", "--identity", join(dir, "key.txt"), "--from", join(dir, "dl"), "--project", "some-real-project", "--apply"], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" } }).catch(
      (error: { code: number; stderr: string }) => error,
    );
    expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining("not recorded in infra/targets.json") });
  });
});
