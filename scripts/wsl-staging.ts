// Staging on the owner's PC2 until the Oracle VM exists (his go of 19 October 2026): the VM's
// staging host rebuilt in a dedicated WSL2 distro, joutiya-staging (Ubuntu 24.04), with the same
// Compose files, paths, deploy command and secret files (/opt/joutiya, /etc/joutiya/staging,
// /var/lib/joutiya), so that moving to the VM is a redeploy there. Run on PC2 from Git Bash at the
// root of an up-to-date checkout of main. Each root script reaches the distro on stdin (wsl.exe),
// never on a command line or in a Windows file. Dry run unless --apply. Production never runs here.
//
//   node scripts/wsl-staging.ts setup [--apply]
//       Docker Engine from Docker's repository (as bootstrap.sh does on the VM), git and zstd; the
//       group and directories of infra/vm/install.sh; the public clone of Joutiya in
//       /opt/joutiya/src; a key pair that receives the sealed staging variables (its public
//       certificate is printed as a `transfer-certificate ...` line).
//   node scripts/wsl-staging.ts wif [--apply]
//       keyless Google access (§9): a key per container made in the distro, its request signed here
//       by the CA of step 9 (~/.joutiya/wif-ca) for 90 days, then the certificate and Workload
//       Identity Federation files installed and running web and worker recreated. Same command to renew.
//   node scripts/wsl-staging.ts deploy [--commit=<sha>] [--apply]
//       a commit of origin/main (default: its head) built in the distro (web and worker, amd64),
//       then started by infra/vm/deploy-forced-command.sh `load` as on the VM (health checks,
//       rollback). While a required variable or secret file is missing, the images are built and
//       the start waits: the output names what is missing.
//   node scripts/wsl-staging.ts env --sealed=<file>[,<file>...] [--apply]
//       files made by scripts/seal-env.ts for this distro's transfer certificate, opened in the
//       distro with its key: their app.env lines are merged as on the VM (vm-env.ts mergeLines, which
//       also generates CSRF_SECRET, the Valkey passwords and Meilisearch's key once), a tunnel.env
//       replaces the current one. Prints names only; `deploy --apply` then starts staging.
//   node scripts/wsl-staging.ts search-setup [--reindex=<max Firestore reads>] [--apply]
//       once a release runs: Meilisearch's index and the app's two keys, written to app.env with
//       MEILI_URL by infra/vm/search-setup.sh as on the VM, then web and worker recreated; --reindex
//       also fills the listings index from Firestore (first start).
//   node scripts/wsl-staging.ts status
//       release, containers and images (read only).
//   node scripts/wsl-staging.ts stop [--apply]
//       staging stopped, volumes kept: before the VM's staging starts, since both would connect to
//       the same tunnel and share its traffic.

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateTargets, type Targets } from "./assert-target.ts";
import { WIF_SERVICES, caFiles, certificateConfig, credentialConfig, csrFromOutput, readCa, signCsr, subjectName } from "./google-wif.ts";
import { REPOSITORY, SECRET_FILES, SOURCE_DIR, searchSetupScript, stagingReleaseLines, wifDir, wifInstallScript, wifKeyScript, wifRecreateScript } from "./oracle-vm.ts";
import { type Sealed, openSealedLines, parseSealed } from "./seal-env.ts";
import { mergeLines } from "./vm-env.ts";

export const DISTRO = "joutiya-staging";
const ENV = "staging";
const ETC = `/etc/joutiya/${ENV}`;
const COMPOSE = `APP_ENV=${ENV} RELEASE="$release" docker compose --project-directory /opt/joutiya/docker -f /opt/joutiya/docker/compose.yml -f /opt/joutiya/docker/compose.${ENV}.yml`;
/** Certificates of this temporary host live shorter than the VM's 365 days; `wif` renews them. */
export const PC_LEAF_DAYS = 90;
export { REPOSITORY, SECRET_FILES, SOURCE_DIR };

// ---------------------------------------------------------------------------------------------
// Running root scripts in the distro.

/**
 * What the distro runs: the script read from stdin into a root-only temporary file, then run with
 * its standard input closed, so that no command inside can read the rest of the script. No double
 * quote: wsl.exe receives it through a Windows command line.
 */
export const RUNNER = "umask 077; f=$(mktemp); trap 'rm -f $f' EXIT; cat > $f; /bin/bash -euo pipefail $f < /dev/null";

export function wslArgs(distro = DISTRO): string[] {
  return ["-d", distro, "-u", "root", "--exec", "/bin/bash", "-c", RUNNER];
}

export interface Command {
  file: string;
  args: string[];
}

/** Runs a script in the distro, its output shown as it comes; resolves with the output, rejects unless it exits 0. */
export function runScript(script: string, command: Command = { file: "wsl.exe", args: wslArgs() }, echo = true): Promise<string> {
  return new Promise((resolve, reject) => {
    // WSL_UTF8: wsl.exe's own messages in UTF-8 instead of UTF-16.
    const child = spawn(command.file, command.args, { env: { ...process.env, WSL_UTF8: "1" }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (echo) process.stdout.write(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new Error(`${command.file} not found: run this on PC2, from Git Bash`) : error));
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`exit ${code ?? "on a signal"}`))));
    child.stdin.end(script);
  });
}

// No parameter properties: Node runs this file by stripping types only.
class Host {
  readonly apply: boolean;
  private readonly run: (script: string) => Promise<string>;

  constructor(apply: boolean, run: (script: string) => Promise<string> = (script) => runScript(script)) {
    this.apply = apply;
    this.run = run;
  }

  /** A script that changes the distro runs only with --apply; a read-only one runs in dry runs too. */
  async exec(label: string, script: string, readOnly = false): Promise<string> {
    if (!this.apply && !readOnly) {
      console.log(`would run  ${label} (${Buffer.byteLength(script)} bytes)`);
      return "";
    }
    console.log(`run        ${label}`);
    try {
      return await this.run(script);
    } catch (error) {
      throw new Error(`${label}: ${(error as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Root scripts.

/** Refuses Docker Desktop's engine, which its WSL integration may put behind `docker`. */
const OWN_ENGINE = [
  'engine="$(docker info --format "{{.OperatingSystem}}" 2> /dev/null || true)"',
  '[[ -n "$engine" && "$engine" != *"Docker Desktop"* ]] || { echo "docker does not reach the Docker Engine of this distro (found: ${engine:-nothing}): turn off Docker Desktop\'s WSL integration for joutiya-staging" >&2; exit 1; }',
];

/**
 * No Windows program may start from the distro: [interop] enabled=false in /etc/wsl.conf leaves
 * WSL's binfmt handlers registered (WSL 3.0 with systemd, seen on PC2), and through them a process
 * of the distro would run Windows programs as the owner. Removed at every boot and before each deploy.
 */
const NO_INTEROP = "/usr/local/sbin/joutiya-no-interop";
const NO_INTEROP_SCRIPT = `#!/bin/sh
for entry in /proc/sys/fs/binfmt_misc/WSLInterop*; do
  if [ -e "$entry" ]; then echo -1 > "$entry"; fi
done`;
const NO_INTEROP_UNIT = `[Unit]
Description=Joutiya staging: no Windows program started from this distro
After=systemd-binfmt.service

[Service]
Type=oneshot
ExecStart=${NO_INTEROP}

[Install]
WantedBy=multi-user.target`;
const INTEROP_CHECK = `if compgen -G '/proc/sys/fs/binfmt_misc/WSLInterop*' > /dev/null; then echo "WSL interop is still registered" >&2; exit 1; fi`;
const INTEROP_GUARD = [`[[ -x ${NO_INTEROP} ]] || { echo "${NO_INTEROP} is missing: run setup first" >&2; exit 1; }`, NO_INTEROP, INTEROP_CHECK];

/** Docker's daemon settings, as on the VM (infra/vm/bootstrap.sh). */
export const DAEMON_JSON = `{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true,
  "no-new-privileges": true
}`;

export function setupScript(): string {
  return [
    // The runner's umask is 077: here only secrets are written with it.
    "umask 022",
    ". /etc/os-release",
    '[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo "joutiya-staging runs $PRETTY_NAME, not Ubuntu 24.04" >&2; exit 1; }',
    '[[ "$(ps -p 1 -o comm=)" == systemd ]] || { echo "systemd is not running: set [boot] systemd=true in /etc/wsl.conf, then wsl.exe --terminate joutiya-staging" >&2; exit 1; }',
    `cat > ${NO_INTEROP} << 'EOF'`,
    NO_INTEROP_SCRIPT,
    "EOF",
    `chmod 0755 ${NO_INTEROP}`,
    "cat > /etc/systemd/system/joutiya-no-interop.service << 'EOF'",
    NO_INTEROP_UNIT,
    "EOF",
    "systemctl daemon-reload",
    "systemctl enable --quiet joutiya-no-interop.service",
    "systemctl start joutiya-no-interop.service",
    INTEROP_CHECK,
    "export DEBIAN_FRONTEND=noninteractive",
    "APT=(apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=5)",
    '"${APT[@]}" update -q',
    '"${APT[@]}" install -y -q ca-certificates curl git zstd openssl python3',
    // Docker Engine from Docker's repository (docs.docker.com/engine/install/ubuntu), as on the VM.
    "if ! command -v dockerd > /dev/null; then",
    "  install -m 0755 -d /etc/apt/keyrings",
    "  curl -fsSL --retry 5 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "  chmod a+r /etc/apt/keyrings/docker.asc",
    "  cat > /etc/apt/sources.list.d/docker.sources << EOF",
    "Types: deb",
    "URIs: https://download.docker.com/linux/ubuntu",
    "Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}",
    "Components: stable",
    "Architectures: $(dpkg --print-architecture)",
    "Signed-By: /etc/apt/keyrings/docker.asc",
    "EOF",
    '  "${APT[@]}" update -q',
    '  "${APT[@]}" install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    "fi",
    "install -d -m 0755 /etc/docker",
    "cat > /etc/docker/daemon.json.new << 'EOF'",
    DAEMON_JSON,
    "EOF",
    "if cmp -s /etc/docker/daemon.json.new /etc/docker/daemon.json; then rm /etc/docker/daemon.json.new; else mv /etc/docker/daemon.json.new /etc/docker/daemon.json; systemctl restart docker; fi",
    "systemctl enable --now docker",
    ...OWN_ENGINE,
    // The layout of infra/vm/install.sh, staging only: secrets root only, gcp/ for the group of
    // web and worker (compose.staging.yml), state of the deploy command.
    "getent group joutiya-staging > /dev/null || groupadd --gid 2002 joutiya-staging",
    "install -d -m 0711 /etc/joutiya",
    `install -d -m 0700 ${ETC}`,
    `install -d -m 0750 -g joutiya-staging ${ETC}/gcp ${ETC}/gcp/web ${ETC}/gcp/worker`,
    "install -d -m 0700 /var/lib/joutiya",
    "install -d -m 0755 /opt/joutiya /opt/joutiya/docker /opt/joutiya/docker/valkey",
    `[[ -d ${SOURCE_DIR}/.git ]] || git clone --quiet ${REPOSITORY} ${SOURCE_DIR}`,
    // Receives the staging variables sealed on the owner's other PC: the key never leaves the distro.
    `if [[ ! -s ${ETC}/transfer.key ]]; then`,
    `  (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out ${ETC}/transfer.key 2> /dev/null)`,
    `  openssl req -x509 -new -key ${ETC}/transfer.key -subj /CN=joutiya-staging-transfer -days 30 -out ${ETC}/transfer.pem`,
    "fi",
    `echo "transfer-certificate $(openssl x509 -in ${ETC}/transfer.pem -outform DER | base64 -w0)"`,
    `echo "docker $(docker version --format '{{.Server.Version}}'), compose $(docker compose version --short), engine $engine"`,
    'echo "setup done"',
  ].join("\n");
}

/**
 * A commit of origin/main built in the distro and, once every secret is in place, loaded and
 * started by the VM's deploy command, which waits for health and rolls back on failure.
 */
export function deployScript(commit?: string): string {
  return [
    // The image keeps the modes of the build context: files checked out as the CI's are (0644).
    "umask 022",
    `[[ -x ${NO_INTEROP} ]] || { echo "${NO_INTEROP} is missing: run setup first" >&2; exit 1; }`,
    NO_INTEROP,
    INTEROP_CHECK,
    ...OWN_ENGINE,
    `[[ -d ${SOURCE_DIR}/.git ]] || { echo "no clone in ${SOURCE_DIR}: run setup first" >&2; exit 1; }`,
    ...stagingReleaseLines(commit),
  ].join("\n");
}

export function statusScript(): string {
  return [
    'release="$(cat /var/lib/joutiya/staging.release 2> /dev/null || true)"',
    'echo "release ${release:-none}"',
    `if [[ -n "$release" ]]; then ${COMPOSE} ps --all; fi`,
    "docker image ls --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}}' | grep '^joutiya-' || true",
  ].join("\n");
}

/**
 * Opens the sealed files with the transfer key made by setup, in a root-only directory removed on
 * exit. Each one must carry inside the label it shows outside; app.env lines must be NAME='value'
 * (envPayload's form), with one value per name across files; a tunnel.env holds one token.
 */
export function envScript(files: Sealed[], etc = "/etc/joutiya"): string {
  if (files.length === 0) throw new Error("env needs --sealed=<file>[,<file>...]");
  const dir = `${etc}/${ENV}`;
  const open = files.flatMap((file, index) => {
    if (file.env !== ENV) throw new Error(`sealed file ${index + 1} is for ${file.env}: this host runs staging only`);
    const base = `"$work/${index + 1}`;
    return [
      `cat > ${base}.pem" << 'JOUTIYA_SEALED'`,
      file.pem.trimEnd(),
      "JOUTIYA_SEALED",
      ...openSealedLines(file, index + 1, dir, "distro"),
      ...(file.target === "app.env"
        ? [`if grep -qvE "$line" ${base}.lines"; then echo "sealed file ${index + 1}: a line is not NAME='value'" >&2; exit 1; fi`, `cat ${base}.lines" >> "$work/app.env"`]
        : [
            `[[ "$(wc -l < ${base}.lines")" -eq 1 ]] && grep -qE '^TUNNEL_TOKEN=[A-Za-z0-9+/=_-]{32,}$' ${base}.lines" || { echo "sealed file ${index + 1}: not a tunnel token" >&2; exit 1; }`,
            `install -m 0600 ${base}.lines" ${dir}/tunnel.env`,
            'echo "tunnel.env written"',
          ]),
    ];
  });
  return [
    "umask 077",
    `[[ -s ${dir}/transfer.key ]] || { echo "no transfer key in ${dir}: run setup first" >&2; exit 1; }`,
    `work="$(mktemp -d ${dir}/.sealed.XXXXXX)"`,
    `trap 'rm -rf "$work" "\${new:-}"' EXIT`,
    `line="^[A-Z][A-Z0-9_]*='[^'[:cntrl:]]*'\$"`,
    ': > "$work/app.env"',
    ...open,
    'if [[ -s "$work/app.env" ]]; then',
    '  LC_ALL=C sort -u -o "$work/app.env" "$work/app.env"',
    `  twice="$(cut -d= -f1 "$work/app.env" | LC_ALL=C uniq -d | tr '\\n' ' ')"`,
    '  [[ -z "$twice" ]] || { echo "sealed files disagree on: $twice" >&2; exit 1; }',
    ...mergeLines(ENV, "$work/app.env", { etc, stage: dir }).map((line) => `  ${line}`),
    "else",
    '  echo "app.env unchanged"',
    "fi",
  ].join("\n");
}

export function stopScript(): string {
  return [
    'release="$(cat /var/lib/joutiya/staging.release 2> /dev/null || true)"',
    '[[ -n "$release" ]] || { echo "staging runs no release"; exit 0; }',
    `${COMPOSE} down`,
    'echo "staging stopped, volumes kept"',
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Actions.

async function wif(host: Host, targets: Targets): Promise<void> {
  const { projectId: project, projectNumber } = targets.environments[ENV].firebase;
  if (project === null || projectNumber === null) throw new Error(`environments.${ENV}.firebase is not recorded in infra/targets.json`);
  const ca = caFiles();
  readCa(ca);
  for (const service of WIF_SERVICES) {
    const subject = subjectName(ENV, service);
    const output = await host.exec(`wif ${service}: new key and request in the distro`, wifKeyScript(ENV, service));
    if (!host.apply) {
      console.log(`would sign  ${subject} here for ${PC_LEAF_DAYS} days, then install it in ${wifDir(ENV, service)}`);
      continue;
    }
    const certificate = signCsr({ csr: csrFromOutput(output), subject, days: PC_LEAF_DAYS, ca });
    const dir = wifDir(ENV, service);
    const files = {
      credentials: JSON.stringify(credentialConfig({ projectNumber, project, service, certificateConfigPath: `${dir}/certificate_config.json` })),
      certificateConfig: JSON.stringify(certificateConfig(`${dir}/cert.pem`, `${dir}/key.pem`)),
    };
    await host.exec(`wif ${service}: certificate and federation files`, wifInstallScript(ENV, service, certificate, files));
  }
  await host.exec("wif: running web and worker recreated", wifRecreateScript(ENV));
  if (host.apply) console.log(`certificates valid ${PC_LEAF_DAYS} days: renew them with this command before they expire`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [action, extra] = args.filter((arg) => !arg.startsWith("--"));
  const actions = ["setup", "wif", "deploy", "env", "search-setup", "status", "stop"];
  if (!action || !actions.includes(action) || extra !== undefined) {
    throw new Error("usage: scripts/wsl-staging.ts <setup|wif|deploy [--commit=<sha>]|env --sealed=<file>[,<file>...]|search-setup [--reindex=<reads>]|status|stop> [--apply]");
  }
  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const errors = validateTargets(raw);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const host = new Host(args.includes("--apply"));
  if (action === "setup") await host.exec("setup", setupScript());
  else if (action === "wif") await wif(host, raw as Targets);
  else if (action === "deploy") await host.exec("deploy", deployScript(args.find((arg) => arg.startsWith("--commit="))?.slice("--commit=".length)));
  else if (action === "env") {
    const sealed = args.find((arg) => arg.startsWith("--sealed="))?.slice("--sealed=".length).split(",").filter((file) => file !== "") ?? [];
    const files = sealed.map((file) => {
      try {
        return parseSealed(readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`);
      }
    });
    await host.exec("env", [...INTEROP_GUARD, envScript(files)].join("\n"));
    if (host.apply) console.log("app.env and the secret files are in place: `deploy --apply` starts staging once nothing is missing.");
  } else if (action === "search-setup") {
    const reindex = args.find((arg) => arg.startsWith("--reindex="))?.slice("--reindex=".length);
    await host.exec("search-setup", [...INTEROP_GUARD, searchSetupScript(ENV, reindex)].join("\n"));
  } else if (action === "stop") await host.exec("stop", stopScript());
  else await host.exec("status", statusScript(), true);
  if (action !== "status") console.log(host.apply ? "\nDone." : "\nDry run: nothing changed in the distro. Add --apply to run these scripts.");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]wsl-staging\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`wsl-staging: ${(error as Error).message}`);
    process.exit(1);
  });
}
