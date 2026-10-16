#!/bin/bash
# First boot of the Joutiya VM (Oracle Always Free Ampere A1, Ubuntu 24.04 aarch64), sent as the
# cloud-init user data by `node scripts/oracle-vm.ts create`, which fills the placeholders in memory
# (tunnel tokens read from the Cloudflare API, a tarball of infra/vm and docker/). Never fill or
# commit a copy by hand.
#
# Keeps the metadata service (which serves this script, tokens included) away from non-root users,
# sets up the two admin channels first (OCI Run Command, then the SSH tunnel), installs Docker, swap
# and unattended upgrades, then this repository's VM files (infra/vm/install.sh) and the two Compose
# tunnels' tokens. The VCN has no ingress rule. Progress lines (no secret) go to the serial console,
# read by `node scripts/oracle-vm.ts status`. Every step is idempotent: a failed run stays as a
# per-boot script and runs again at the next boot (`node scripts/oracle-vm.ts reboot --apply`), so a
# transient failure never costs the instance.
set -Eeuo pipefail

SSH_TUNNEL_TOKEN='__JOUTIYA_SSH_TUNNEL_TOKEN__'
STAGING_TUNNEL_TOKEN='__JOUTIYA_STAGING_TUNNEL_TOKEN__'
PROD_TUNNEL_TOKEN='__JOUTIYA_PROD_TUNNEL_TOKEN__'
VM_FILES='__JOUTIYA_VM_FILES__'

readonly LOG=/var/log/joutiya-bootstrap.log
readonly AGAIN=/var/lib/cloud/scripts/per-boot/joutiya-bootstrap.sh
[[ -e "$LOG" ]] || install -m 0600 /dev/null "$LOG"
exec >> "$LOG" 2>&1
progress() { echo "joutiya-bootstrap: $*"; echo "joutiya-bootstrap: $*" > /dev/console 2> /dev/null || true; }
finish() {
  local status=$?
  if ((status == 0)); then
    rm -f "$AGAIN"
    return
  fi
  # Root only (0700), like cloud-init's own copy of this script.
  [[ "$0" -ef "$AGAIN" ]] || install -D -m 0700 "$0" "$AGAIN"
  progress "failed (exit $status, see $LOG): runs again at the next boot"
}
trap finish EXIT
trap 'progress "failed at line $LINENO"' ERR
# Network steps are retried: apt's daily timers may hold the dpkg lock, a mirror may blink.
retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    "$@" && return 0
    progress "attempt $attempt failed: $*"
    sleep 20
  done
  "$@"
}
APT=(apt-get -o DPkg::Lock::Timeout=600)
export DEBIAN_FRONTEND=noninteractive
progress "start $(date -u +%FT%TZ)"
for value in "$SSH_TUNNEL_TOKEN" "$STAGING_TUNNEL_TOKEN" "$PROD_TUNNEL_TOKEN" "$VM_FILES"; do
  if [[ "$value" == __* ]]; then
    progress "a placeholder was not filled in"
    exit 1
  fi
done

retry "${APT[@]}" update
retry "${APT[@]}" install -y ca-certificates curl zstd unattended-upgrades iptables-persistent
write_secret() { (umask 077 && printf '%s\n' "$2" > "$1"); }
files="$(mktemp -d)"
base64 -d <<< "$VM_FILES" | tar -xzf - -C "$files"

# Admin channel 1, OCI Run Command: the Oracle Cloud Agent (snap) runs its scripts as ocarun, made
# root through sudo at once, so the VM stays manageable if a later step fails (install.sh keeps the
# file current). Who may send commands is decided by OCI IAM. The agent's users must exist before
# the metadata rule below.
snap wait system seed.loaded
if snap list oracle-cloud-agent > /dev/null 2>&1; then snap refresh oracle-cloud-agent || true; else retry snap install oracle-cloud-agent --classic; fi
progress "oracle-cloud-agent $(snap list oracle-cloud-agent | awk 'NR == 2 { print $2 }'), ocarun $(id -u ocarun 2> /dev/null || echo missing)"
install -m 0440 "$files/infra/vm/sudoers.oracle-run-command" /etc/sudoers.d/.run-command.new
visudo -cqf /etc/sudoers.d/.run-command.new
mv /etc/sudoers.d/.run-command.new /etc/sudoers.d/101-oracle-cloud-agent-run-command

# Instance metadata (HTTP on 169.254.169.254, which serves this script and its tokens) for root and
# the Oracle Cloud Agent only (snap_daemon, and ocarun for Run Command): Oracle recommends root only,
# but the snap agent runs unprivileged. Saved with the image's own rules (loaded from
# /etc/iptables/rules.v4 at boot). Only port 80: the same address is the VCN's DNS (53) and NTP
# (123) server, used by non-root systemd services. Containers are blocked separately
# (infra/vm/joutiya-docker-firewall.service).
iptables -N JOUTIYA-IMDS 2> /dev/null || iptables -F JOUTIYA-IMDS
for user in root snap_daemon ocarun; do
  if id -u "$user" > /dev/null 2>&1; then iptables -A JOUTIYA-IMDS -m owner --uid-owner "$user" -j RETURN; fi
done
iptables -A JOUTIYA-IMDS -j DROP
iptables -C OUTPUT -d 169.254.169.254/32 -p tcp --dport 80 -j JOUTIYA-IMDS 2> /dev/null \
  || iptables -I OUTPUT 1 -d 169.254.169.254/32 -p tcp --dport 80 -j JOUTIYA-IMDS
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4
imds() { sudo -u "$1" curl -fsS -m 5 -o /dev/null -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/id 2> /dev/null; }
if imds nobody; then progress "WARNING: a non-root user reaches the metadata service"; fi
if id -u snap_daemon > /dev/null 2>&1 && ! imds snap_daemon; then progress "WARNING: the Oracle Cloud Agent cannot reach the metadata service"; fi

# Admin channel 2, the SSH tunnel: once the zone is active, ssh.joutiya.ma reaches the VM even if a
# later step fails. cloudflared from Cloudflare's repository (pkg.cloudflare.com), updated by apt.
# The token goes in a root-only file, never on the command line (`cloudflared service install
# <token>` would put it in a world-readable unit and in the process list).
install -d -m 0755 /usr/share/keyrings
retry curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list

retry "${APT[@]}" update
retry "${APT[@]}" install -y cloudflared
install -d -m 0711 /etc/joutiya
write_secret /etc/joutiya/ssh-tunnel.env "TUNNEL_TOKEN=$SSH_TUNNEL_TOKEN"
install -m 0644 "$files/infra/vm/cloudflared-ssh.service" /etc/systemd/system/cloudflared.service
systemctl daemon-reload
systemctl enable --now cloudflared
progress "ssh tunnel started"

# Swap: 4 GB on the boot volume, used only under memory pressure.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-joutiya.conf
sysctl --system > /dev/null

# Docker Engine from Docker's repository (docs.docker.com/engine/install/ubuntu).
install -m 0755 -d /etc/apt/keyrings
retry curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
# shellcheck disable=SC1091
CODENAME="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
cat > /etc/apt/sources.list.d/docker.sources << EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

retry "${APT[@]}" update
retry "${APT[@]}" install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Docker: bounded logs; containers keep running while the daemon restarts (apt upgrades).
install -d -m 0755 /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true,
  "no-new-privileges": true
}
EOF
systemctl enable docker
systemctl restart docker
progress "docker installed"

# Security updates every day, Docker and cloudflared included; a reboot, when an update needs
# one, happens at night (containers restart on their own, the probe tolerates 10 minutes).
cat > /etc/apt/apt.conf.d/52joutiya-unattended-upgrades << 'EOF'
Unattended-Upgrade::Origins-Pattern {
  "site=download.docker.com";
  "site=pkg.cloudflare.com";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
EOF
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades

# This repository's VM files: users, sshd, sudoers, Compose files, container firewall. Later
# changes go through the same install.sh.
bash "$files/infra/vm/install.sh" "$files"
rm -rf "$files"
progress "vm files installed"

# Tokens of the Compose tunnels, root only (docker/compose.yml reads /etc/joutiya/<env>/tunnel.env).
write_secret /etc/joutiya/staging/tunnel.env "TUNNEL_TOKEN=$STAGING_TUNNEL_TOKEN"
write_secret /etc/joutiya/prod/tunnel.env "TUNNEL_TOKEN=$PROD_TUNNEL_TOKEN"

# Self-check: the tokens stay root only. cloud-init redacts the user data from its world-readable
# instance data, and no world-readable file may hold a token.
if grep -qsE '"user_data": "[A-Za-z0-9+/=]{100,}' /run/cloud-init/instance-data.json; then progress "WARNING: the user data is in /run/cloud-init/instance-data.json"; fi
for token in "$SSH_TUNNEL_TOKEN" "$STAGING_TUNNEL_TOKEN" "$PROD_TUNNEL_TOKEN"; do
  while IFS= read -r file; do
    if [[ -n "$(find "$file" -perm -0004)" ]]; then progress "WARNING: a tunnel token is in world-readable $file"; fi
  done < <(grep -rlsF -D skip -- "$token" /etc /run/cloud-init /var/lib/cloud /var/log)
done
unset SSH_TUNNEL_TOKEN STAGING_TUNNEL_TOKEN PROD_TUNNEL_TOKEN VM_FILES token

# Host key for the known_hosts line of ssh.joutiya.ma (public).
progress "host key $(cut -d ' ' -f 1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
progress "done $(date -u +%FT%TZ)"
