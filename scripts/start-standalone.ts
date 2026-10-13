// Runs the production build exactly as the Docker `web` target does: standalone server,
// static assets beside it, CSP hash hook preloaded. Used by Playwright and for local checks.
//   npm run build && node scripts/start-standalone.ts

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = `${root}.next/standalone`;
if (!existsSync(`${app}/server.js`)) {
  console.error("start-standalone: run `npm run build` first");
  process.exit(1);
}
cpSync(`${root}.next/static`, `${app}/.next/static`, { recursive: true });
cpSync(`${root}public`, `${app}/public`, { recursive: true });
cpSync(`${root}dist/server`, `${app}/dist/server`, { recursive: true });
mkdirSync(`${app}/infra`, { recursive: true });
cpSync(`${root}infra/targets.json`, `${app}/infra/targets.json`);

// Next resolves proxy rewrites against its own host: with HOSTNAME=127.0.0.1 the admin-host
// rewrite is treated as external. "localhost" (here) and "0.0.0.0" (Docker) keep it internal.
// The shell's HOSTNAME (machine name) is ignored on purpose.
const child = spawn(process.execPath, ["--import", "./dist/server/csp-hash-hook.mjs", "server.js"], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, PORT: process.env.PORT ?? "3000", HOSTNAME: process.env.STANDALONE_HOST ?? "localhost" },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
