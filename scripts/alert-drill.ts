// P0 alert drill (phase 6, D16): one P0 tagged DRILL through the app's alert path (deliver() in
// src/lib/alert, the channels and formatting real alerts use), so the owner checks that Telegram
// rings and the e-mail relay delivers. The incident procedure runs it once before launch and after
// any change to a channel. Without the hourly dedupe: each drill goes out, under a unique title.
//
// Runs where the alert secrets are, in the worker container of the environment (bundled by
// scripts/build-node.ts):
//
//   docker compose exec worker node dist/worker/alert-drill.mjs [--apply]
//
// Dry run by default: prints the environment, the configured channels and the message, sends
// nothing. With --apply: sends it and prints each channel's outcome; exits 1 when no channel is
// configured or one failed or is switched off. Prints channel names only, never a token or a URL.

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Alert, ChannelOutcome } from "@/lib/alert";
import { requireEnvProxy } from "./env-proxy.ts";

export interface DrillDeps {
  env: string;
  channels: string[];
  deliver: (alert: Alert) => Promise<ChannelOutcome[]>;
  now: Date;
  id: string;
  log: (line: string) => void;
}

export function drillAlert(id: string, now: Date): Alert {
  return {
    severity: "P0",
    title: `DRILL ${id} · exercice d'alerte`,
    body: [
      "Exercice : aucune action sur le site.",
      `Envoyé le ${now.toISOString()} par scripts/alert-drill.ts.`,
      "Vérifier la sonnerie Telegram et la réception de l'e-mail, puis noter les heures dans le journal des exercices (procédure d'incident, section Exercices).",
    ].join("\n"),
  };
}

/** Returns the exit code. */
export async function runDrill(apply: boolean, deps: DrillDeps): Promise<number> {
  const alert = drillAlert(deps.id, deps.now);
  deps.log(`Environment: ${deps.env}. Channels: ${deps.channels.length > 0 ? deps.channels.join(", ") : "none"}.`);
  deps.log(`Message: ${alert.severity} · ${alert.title}`);
  if (deps.channels.length === 0) {
    deps.log("No alert channel is configured (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, ALERT_RELAY_URL + ALERT_RELAY_SECRET).");
    return apply ? 1 : 0;
  }
  if (!apply) {
    deps.log("Dry run: nothing sent. Add --apply to send the drill.");
    return 0;
  }
  const outcomes = await deps.deliver(alert);
  for (const outcome of outcomes) deps.log(`${outcome.channel}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ""}`);
  return outcomes.every((outcome) => outcome.status === "sent") ? 0 : 1;
}

async function main(): Promise<number> {
  requireEnvProxy();
  // Loaded here: the module reads the server environment, which the unit tests never set.
  const { alertChannelNames, deliver } = await import("@/lib/alert");
  const { serverEnv } = await import("@/lib/env");
  return runDrill(process.argv.includes("--apply"), {
    env: serverEnv().APP_ENV,
    channels: alertChannelNames(),
    deliver,
    now: new Date(),
    id: randomBytes(3).toString("hex"),
    log: (line) => console.log(line),
  });
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]alert-drill\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`alert-drill: ${(error as Error).message}`);
      process.exit(1);
    });
}
