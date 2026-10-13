#!/usr/bin/env bash
# Installs this repository's VM files on the Joutiya VM. Run as root by `scripts/deploy-prod.ts
# vm-sync`, which streams infra/vm, docker/ and the deploy users' public keys over SSH and calls
#   install.sh <extracted directory>
# Idempotent. sshd and sudoers changes are validated before they replace the running ones.
# Secrets are never handled here: /etc/joutiya/<env>/*.env are written by the owner (redeploy.md).
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

# Deploy users: no password, not in the docker group; sshd forces their only command.
for user in deploy-staging deploy-prod; do
  id "$user" > /dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group "$user"
  passwd --lock "$user" > /dev/null
done

# authorized_keys owned by root: the deploy users cannot change their own keys.
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
install_keys deploy-prod "$KEYS/deploy-prod.pub"

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

# sudoers: validated before it is moved into place.
install -m 0440 -o root -g root "$SRC/infra/vm/sudoers.joutiya-deploy" /etc/sudoers.d/.joutiya-deploy.new
visudo -cqf /etc/sudoers.d/.joutiya-deploy.new
mv /etc/sudoers.d/.joutiya-deploy.new /etc/sudoers.d/joutiya-deploy

# sshd: the new drop-in is tested with the full configuration; the previous one comes back on error.
readonly SSHD_DROPIN=/etc/ssh/sshd_config.d/10-joutiya.conf
[[ -f "$SSHD_DROPIN" ]] && cp -p "$SSHD_DROPIN" "$SSHD_DROPIN.previous"
install -m 0644 -o root -g root "$SRC/infra/vm/sshd_config.d/joutiya.conf" "$SSHD_DROPIN"
if ! sshd -t; then
  if [[ -f "$SSHD_DROPIN.previous" ]]; then mv "$SSHD_DROPIN.previous" "$SSHD_DROPIN"; else rm -f "$SSHD_DROPIN"; fi
  log "sshd configuration rejected: previous one restored"
  exit 1
fi
rm -f "$SSHD_DROPIN.previous"
systemctl reload ssh

# Containers never reach the instance metadata service (169.254.169.254): it serves the cloud-init
# user data, which holds the SSH tunnel token.
install -m 0644 -o root -g root "$SRC/infra/vm/joutiya-docker-firewall.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now joutiya-docker-firewall.service
systemctl restart joutiya-docker-firewall.service

log "done"
