// Entry point of the web image: `node --import ./dist/server/csp-hash-hook.mjs dist/server/web-cluster.mjs`.
// One Next.js server is one JavaScript thread: in the load test of 30 Oct 2026 it saturated near one
// core while its container had 1.5 (docs/lancement/charge.md). WEB_PROCESSES (1 to 4, default 1)
// starts that many standalone servers on the same port through node:cluster; each inherits the
// preloaded CSP hash hook (execArgv). Each process keeps its own in-memory ISR cache: revalidatePath
// reaches only the process that ran it, the others refresh the page at its `revalidate` (the edge
// cache already keeps it as long).

import cluster from "node:cluster";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Processes started by the primary; past this a 2-OCPU VM gains nothing. */
export const MAX_WEB_PROCESSES = 4;
/** A process that dies is started again after this delay (a crash loop stays visible, not hot). */
export const RESTART_DELAY_MS = 1_000;
/** On SIGTERM the servers get this long to finish before the primary exits (Docker kills at 10 s). */
export const STOP_GRACE_MS = 8_000;

/** WEB_PROCESSES as a count: unset or empty means 1; anything else must be an integer 1 to 4. */
export function webProcessCount(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_WEB_PROCESSES) throw new RangeError(`WEB_PROCESSES must be an integer from 1 to ${MAX_WEB_PROCESSES}, got "${value}"`);
  return count;
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ level: 40, time: Date.now(), msg: `web-cluster: ${message}`, ...fields })}\n`);
}

/** The standalone server, next to dist/ in the image; a computed path keeps esbuild from bundling it. */
function startServer(): void {
  const server = fileURLToPath(new URL("../../server.js", import.meta.url));
  createRequire(import.meta.url)(server);
}

function runPrimary(count: number): void {
  let stopping = false;
  let running = 0;
  const fork = () => {
    running += 1;
    cluster.fork();
  };
  cluster.on("exit", (worker, code, signal) => {
    running -= 1;
    if (stopping) {
      if (running === 0) process.exit(0);
      return;
    }
    log("a server process exited, starting another", { pid: worker.process.pid, code, signal });
    setTimeout(fork, RESTART_DELAY_MS);
  });
  for (const name of ["SIGTERM", "SIGINT"] as const) {
    process.on(name, () => {
      if (stopping) return;
      stopping = true;
      for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill(name);
      setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
    });
  }
  for (let index = 0; index < count; index += 1) fork();
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]web-cluster\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  if (cluster.isWorker) startServer();
  else {
    const count = webProcessCount(process.env.WEB_PROCESSES);
    if (count === 1) startServer();
    else runPrimary(count);
  }
}
