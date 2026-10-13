// Production operations from the owner's machine (§2): the deploy-prod key and the admin key
// never leave it. Everything goes through SSH aliases defined in ~/.ssh/config (docs/phase-1.md),
// with cloudflared and Cloudflare Access in front of sshd.
//
//   node scripts/deploy-prod.ts status               releases and image IDs running on the VM
//   node scripts/deploy-prod.ts promote              staging release -> production, after confirmation
//   node scripts/deploy-prod.ts rollback             production back to its previous release
//   node scripts/deploy-prod.ts vm-sync              installs infra/vm and docker/ on the VM (admin)
//   node scripts/deploy-prod.ts firestore            deploys Firestore rules and indexes to production
//
// SSH aliases: JOUTIYA_SSH_PROD (default joutiya-deploy-prod), JOUTIYA_SSH_ADMIN (default joutiya).
// Public keys sent by vm-sync: JOUTIYA_DEPLOY_STAGING_PUBKEY, JOUTIYA_DEPLOY_PROD_PUBKEY (default
// ~/.ssh/joutiya_deploy_staging.pub and ~/.ssh/joutiya_deploy_prod.pub).

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { validateTargets, type Targets } from "./assert-target.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SSH_PROD = process.env.JOUTIYA_SSH_PROD?.trim() || "joutiya-deploy-prod";
const SSH_ADMIN = process.env.JOUTIYA_SSH_ADMIN?.trim() || "joutiya";

const RELEASE = /^[0-9a-f]{12,40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface EnvStatus {
  release: string;
  web: string;
  worker: string;
}
export type VmStatus = Record<"staging" | "prod", EnvStatus>;

/** Parses the JSON printed by the forced command's `status` action. */
export function parseStatus(text: string): VmStatus {
  const value = JSON.parse(text) as Partial<VmStatus>;
  for (const env of ["staging", "prod"] as const) {
    const item = value[env];
    if (!item || typeof item.release !== "string" || typeof item.web !== "string" || typeof item.worker !== "string") {
      throw new Error(`unexpected status from the VM: ${env} is missing`);
    }
  }
  return value as VmStatus;
}

/** The promote request, built only from values that passed validation. */
export function promoteCommand(staging: EnvStatus): string {
  if (!RELEASE.test(staging.release)) throw new Error("staging runs no valid release");
  if (!IMAGE_ID.test(staging.web) || !IMAGE_ID.test(staging.worker)) throw new Error("staging image IDs are missing");
  return `promote ${staging.release} ${staging.web} ${staging.worker}`;
}

// No BatchMode: ssh asks for the key passphrase on the terminal (the keys of docs/phase-1.md have
// one; AddKeysToAgent in ~/.ssh/config keeps it for the next calls).
function ssh(alias: string, command: string): string {
  const result = spawnSync("ssh", [alias, command], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) throw new Error(`ssh ${alias}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ssh ${alias} "${command.split(" ")[0]}" failed (exit ${result.status})`);
  return result.stdout;
}

async function confirm(question: string, expected: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question}\nTapez ${expected} pour confirmer : `)).trim();
  rl.close();
  if (answer !== expected) throw new Error("annulé");
}

function isOnMain(release: string): boolean {
  spawnSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: root, stdio: "ignore" });
  return spawnSync("git", ["merge-base", "--is-ancestor", release, "origin/main"], { cwd: root, stdio: "ignore" }).status === 0;
}

function readTargets(): Targets {
  const raw: unknown = JSON.parse(readFileSync(join(root, "infra/targets.json"), "utf8"));
  const errors = validateTargets(raw);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return raw as Targets;
}

function status(): VmStatus {
  return parseStatus(ssh(SSH_PROD, "status"));
}

function printStatus(current: VmStatus): void {
  for (const env of ["staging", "prod"] as const) {
    const { release, web, worker } = current[env];
    console.log(`${env.padEnd(8)} ${release || "(aucune version)"}  web ${web.slice(7, 19) || "-"}  worker ${worker.slice(7, 19) || "-"}`);
  }
}

async function promote(): Promise<void> {
  const current = status();
  printStatus(current);
  const command = promoteCommand(current.staging);
  if (current.staging.release === current.prod.release) throw new Error("la production exécute déjà cette version");
  if (!isOnMain(current.staging.release)) {
    throw new Error(`la version ${current.staging.release} n'est pas un commit de origin/main : promotion refusée`);
  }
  const short = current.staging.release.slice(0, 7);
  await confirm(`Promouvoir ${current.staging.release} (testée en staging) en production ?`, short);
  ssh(SSH_PROD, command);
  printStatus(status());
}

async function rollback(): Promise<void> {
  printStatus(status());
  await confirm("Revenir à la version précédente de la production ?", "rollback");
  ssh(SSH_PROD, "rollback");
  printStatus(status());
}

/** Streams infra/vm, docker/ and the deploy public keys to the VM and runs install.sh as root. */
async function vmSync(): Promise<void> {
  const keys = {
    "deploy-staging.pub": process.env.JOUTIYA_DEPLOY_STAGING_PUBKEY?.trim() || join(homedir(), ".ssh/joutiya_deploy_staging.pub"),
    "deploy-prod.pub": process.env.JOUTIYA_DEPLOY_PROD_PUBKEY?.trim() || join(homedir(), ".ssh/joutiya_deploy_prod.pub"),
  };
  const staging = mkdtempSync(join(tmpdir(), "joutiya-vm-sync-"));
  try {
    mkdirSync(join(staging, "keys"));
    for (const [name, path] of Object.entries(keys)) {
      if (existsSync(path)) copyFileSync(path, join(staging, "keys", name));
      else console.warn(`clé publique absente, ignorée : ${path}`);
    }
    await confirm(`Installer infra/vm et docker/ sur la VM (${SSH_ADMIN}) ?`, "installer");
    const remote = 'set -e; d=$(mktemp -d); trap "rm -rf $d" EXIT; tar -xzf - -C "$d"; bash "$d/infra/vm/install.sh" "$d"';
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["-czf", "-", "-C", root, "infra/vm", "docker/compose.yml", "docker/compose.prod.yml", "docker/compose.staging.yml", "docker/valkey", "-C", staging, "keys"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const remoteShell = spawn("ssh", [SSH_ADMIN, `sudo -n bash -c '${remote}'`], { stdio: [tar.stdout, "inherit", "inherit"] });
      tar.on("error", reject);
      remoteShell.on("error", reject);
      remoteShell.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`install.sh failed (exit ${code})`))));
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function firestore(): Promise<void> {
  const project = readTargets().environments.prod.firebase.projectId;
  if (!project) throw new Error("environments.prod.firebase.projectId must be recorded in infra/targets.json first");
  await confirm(`Déployer firestore.rules et firestore.indexes.json sur ${project} ?`, project);
  const result = spawnSync("npx", ["firebase", "deploy", "--only", "firestore:rules,firestore:indexes", "--project", project, "--non-interactive"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) throw new Error("firebase deploy failed");
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "status") printStatus(status());
  else if (action === "promote") await promote();
  else if (action === "rollback") await rollback();
  else if (action === "vm-sync") await vmSync();
  else if (action === "firestore") await firestore();
  else throw new Error("usage: scripts/deploy-prod.ts <status|promote|rollback|vm-sync|firestore>");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]deploy-prod\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`deploy-prod: ${(error as Error).message}`);
    process.exit(1);
  });
}
