// Production Firestore rules and indexes from the owner's machine (`firebase login`), until the
// CI deployer of phase 2 takes over:
//
//   node scripts/deploy-prod.ts firestore       deploys firestore.rules and firestore.indexes.json
//
// The VM itself (status, promote, rollback, file sync) is run by Claude through OCI Run Command:
// scripts/oracle-vm.ts. No production SSH key exists.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { validateTargets, type Targets } from "./assert-target.ts";
import { requireEnvProxy } from "./env-proxy.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

async function confirm(question: string, expected: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question}\nTapez ${expected} pour confirmer : `)).trim();
  rl.close();
  if (answer !== expected) throw new Error("annulé");
}

function readTargets(): Targets {
  const raw: unknown = JSON.parse(readFileSync(join(root, "infra/targets.json"), "utf8"));
  const errors = validateTargets(raw);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return raw as Targets;
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
  requireEnvProxy();
  const action = process.argv[2];
  if (action === "firestore") await firestore();
  else throw new Error("usage: scripts/deploy-prod.ts firestore");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]deploy-prod\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`deploy-prod: ${(error as Error).message}`);
    process.exit(1);
  });
}
