#!/usr/bin/env bash
# Installs this repository's VM files on the Joutiya VM. Run as root at first boot by bootstrap.sh,
# then by `scripts/oracle-vm.ts sync` (OCI Run Command), which sends infra/vm, docker/ and, when it
# changes, the CI's public key (keys/deploy-staging.pub), and calls
#   install.sh <extracted directory>
# Idempotent. sshd and sudoers changes are validated before they replace the running ones.
# Secrets are never handled here: bootstrap.sh writes the tunnel tokens, the other
# /etc/joutiya/<env>/*.env files come later (docs/phase-1.md).
set -euo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly SRC="${1:?usage: install.sh <source directory>}"
readonly KEYS="$SRC/keys"

log() { printf 'install: %s\n' "$*"; }

# Groups that alone read each environment's Google credentials (compose.<env>.yml runs web and
# worker with these gids).
ensure_group() { getent group "$1" > /dev/null || groupadd --gid "$2" "$1"; }
ensure_group joutiya-prod 2001
ensure_group joutiya-staging 2002

# The CI's deploy user (staging only): no password, not in the docker group; sshd forces its only
# command. Production has no SSH user: root runs it through OCI Run Command (scripts/oracle-vm.ts).
id deploy-staging > /dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group deploy-staging
passwd --lock deploy-staging > /dev/null
# deploy-prod (the owner's SSH key) was retired for Run Command in October 2026.
if id deploy-prod > /dev/null 2>&1; then userdel --remove deploy-prod 2> /dev/null; fi

# authorized_keys owned by root: the deploy user cannot change its own key.
install_keys() {
  local user="$1" file="$2" home
  [[ -s "$file" ]] || { log "no key for $user (kept as is)"; return 0; }
  home="$(getent passwd "$user" | cut -d: -f6)"
  install -d -m 0755 -o root -g root "$home/.ssh"
  { grep -E '^(ssh-ed25519|sk-ssh-ed25519@openssh.com|ecdsa-sha2-nistp256) ' "$file" || true; } | sed 's/^/restrict /' > "$home/.ssh/authorized_keys.new"
  [[ -s "$home/.ssh/authorized_keys.new" ]] || { rm -f "$home/.ssh/authorized_keys.new"; log "no usable key in $file"; return 1; }
  chmod 0644 "$home/.ssh/authorized_keys.new"
  mv "$home/.ssh/authorized_keys.new" "$home/.ssh/authorized_keys"
  log "key installed for $user"
}
install_keys deploy-staging "$KEYS/deploy-staging.pub"

# Directories. Secrets: /etc/joutiya/<env> (root only), gcp/ readable by the environment's group.
install -d -m 0711 -o root -g root /etc/joutiya
for env in prod staging; do
  install -d -m 0700 -o root -g root "/etc/joutiya/$env"
  install -d -m 0750 -o root -g "joutiya-$env" "/etc/joutiya/$env/gcp" "/etc/joutiya/$env/gcp/web" "/etc/joutiya/$env/gcp/worker"
  find "/etc/joutiya/$env/gcp" -type f -exec chown root:"joutiya-$env" {} + -exec chmod 0640 {} +
  find "/etc/joutiya/$env" -maxdepth 1 -type f -name '*.env' -exec chown root:root {} + -exec chmod 0600 {} +
done
install -d -m 0700 -o root -g root /var/lib/joutiya
install -d -m 0755 -o root -g root /opt/joutiya/docker /opt/joutiya/docker/valkey

# Compose files come from the repository through this script only, never from an image: a
# compromised staging deploy key must not be able to change what runs in production.
install -m 0644 -o root -g root "$SRC"/docker/compose.yml "$SRC"/docker/compose.prod.yml "$SRC"/docker/compose.staging.yml /opt/joutiya/docker/
install -m 0644 -o root -g root "$SRC"/docker/valkey/*.conf /opt/joutiya/docker/valkey/
install -m 0755 -o root -g root "$SRC/infra/vm/deploy-forced-command.sh" /usr/local/sbin/joutiya-deploy

# sudoers: each file validated before it is moved into place (sudo skips names with a dot).
install_sudoers() {
  install -m 0440 -o root -g root "$SRC/infra/vm/$1" "/etc/sudoers.d/.$2.new"
  visudo -cqf "/etc/sudoers.d/.$2.new"
  mv "/etc/sudoers.d/.$2.new" "/etc/sudoers.d/$2"
}
install_sudoers sudoers.joutiya-deploy joutiya-deploy
install_sudoers sudoers.oracle-run-command 101-oracle-cloud-agent-run-command

# Host cloudflared of joutiya-ssh-tunnel: a new unit applies at its next restart, never now (this
# script may itself run over that tunnel).
install -m 0644 -o root -g root "$SRC/infra/vm/cloudflared-ssh.service" /etc/systemd/system/cloudflared.service

# sshd: the new drop-in is tested with the full configuration; the previous one comes back on error.
readonly SSHD_DROPIN=/etc/ssh/sshd_config.d/10-joutiya.conf
[[ -f "$SSHD_DROPIN" ]] && cp -p "$SSHD_DROPIN" "$SSHD_DROPIN.previous"
install -m 0644 -o root -g root "$SRC/infra/vm/sshd_config.d/joutiya.conf" "$SSHD_DROPIN"
# Ubuntu 24.04 starts sshd on the first connection (ssh.socket): at first boot its runtime
# directory, which `sshd -t` requires, may not exist yet.
install -d -m 0755 /run/sshd
if ! sshd -t; then
  if [[ -f "$SSHD_DROPIN.previous" ]]; then mv "$SSHD_DROPIN.previous" "$SSHD_DROPIN"; else rm -f "$SSHD_DROPIN"; fi
  log "sshd configuration rejected: previous one restored"
  exit 1
fi
rm -f "$SSHD_DROPIN.previous"
# Reloads a running sshd only; a socket-activated one reads the new file on the next connection.
systemctl try-reload-or-restart ssh

# Containers never reach the instance metadata service (169.254.169.254): it serves the cloud-init
# user data, which holds the SSH tunnel token.
install -m 0644 -o root -g root "$SRC/infra/vm/joutiya-docker-firewall.service" /etc/systemd/system/
systemctl daemon-reload
if [[ -f /etc/joutiya/ssh-tunnel.env ]]; then systemctl enable cloudflared.service; fi
systemctl enable --now joutiya-docker-firewall.service
systemctl restart joutiya-docker-firewall.service

log "done"
