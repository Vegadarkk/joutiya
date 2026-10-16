#!/bin/bash
# First boot of the Joutiya VM (Oracle Always Free Ampere A1, Ubuntu 24.04 aarch64), sent as the
# cloud-init user data by `node scripts/oracle-vm.ts create`, which fills the placeholders in memory
# (tunnel tokens read from the Cloudflare API, a tarball of infra/vm and docker/). Never fill or
# commit a copy by hand.
#
# Keeps the metadata service (which serves this script, tokens included) away from non-root users,
# starts the SSH tunnel, installs Docker, swap and unattended upgrades, then this repository's VM
# files (infra/vm/install.sh) and the two Compose tunnels' tokens. The VCN has no ingress rule: the
# VM is reached through ssh.joutiya.ma (Cloudflare Access) or OCI Run Command. Progress lines (no
# secret) go to the serial console, readable through the OCI console history.
set -euo pipefail

SSH_TUNNEL_TOKEN='__JOUTIYA_SSH_TUNNEL_TOKEN__'
STAGING_TUNNEL_TOKEN='__JOUTIYA_STAGING_TUNNEL_TOKEN__'
PROD_TUNNEL_TOKEN='__JOUTIYA_PROD_TUNNEL_TOKEN__'
VM_FILES='__JOUTIYA_VM_FILES__'

install -m 0600 /dev/null /var/log/joutiya-bootstrap.log
exec >> /var/log/joutiya-bootstrap.log 2>&1
progress() { echo "joutiya-bootstrap: $*"; echo "joutiya-bootstrap: $*" > /dev/console 2> /dev/null || true; }
trap 'progress "failed at line $LINENO (see /var/log/joutiya-bootstrap.log)"' ERR
progress "start $(date -u +%FT%TZ)"
export DEBIAN_FRONTEND=noninteractive
for value in "$SSH_TUNNEL_TOKEN" "$STAGING_TUNNEL_TOKEN" "$PROD_TUNNEL_TOKEN" "$VM_FILES"; do
  if [[ "$value" == __* ]]; then
    progress "a placeholder was not filled in"
    exit 1
  fi
done

apt-get update
apt-get install -y ca-certificates curl zstd unattended-upgrades iptables-persistent

# Instance metadata (HTTP on 169.254.169.254) for root only, as Oracle recommends; saved with the
# image's own rules (Oracle images load /etc/iptables/rules.v4 at boot). Only port 80: the same
# address is the VCN's DNS (53) and NTP (123) server, used by non-root systemd services. Containers
# are blocked separately (infra/vm/joutiya-docker-firewall.service).
iptables -C OUTPUT -d 169.254.169.254/32 -p tcp --dport 80 -m owner ! --uid-owner 0 -j DROP 2> /dev/null \
  || iptables -I OUTPUT 1 -d 169.254.169.254/32 -p tcp --dport 80 -m owner ! --uid-owner 0 -j DROP
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4

# SSH tunnel first: if a later step fails, the VM is still reachable and can be fixed over SSH.
# cloudflared from Cloudflare's repository (pkg.cloudflare.com), updated by apt.
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list

apt-get update
apt-get install -y cloudflared
cloudflared service install "$SSH_TUNNEL_TOKEN"
systemctl enable --now cloudflared
progress "ssh tunnel installed"

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
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
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

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

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
# changes go through the same install.sh (scripts/oracle-vm.ts sync).
files="$(mktemp -d)"
base64 -d <<< "$VM_FILES" | tar -xzf - -C "$files"
bash "$files/infra/vm/install.sh" "$files"
rm -rf "$files"
progress "vm files installed"

# Tokens of the Compose tunnels, root only (docker/compose.yml reads /etc/joutiya/<env>/tunnel.env).
write_secret() { (umask 077 && printf '%s\n' "$2" > "$1"); }
write_secret /etc/joutiya/staging/tunnel.env "TUNNEL_TOKEN=$STAGING_TUNNEL_TOKEN"
write_secret /etc/joutiya/prod/tunnel.env "TUNNEL_TOKEN=$PROD_TUNNEL_TOKEN"
unset SSH_TUNNEL_TOKEN STAGING_TUNNEL_TOKEN PROD_TUNNEL_TOKEN VM_FILES

# Host key for the known_hosts line of ssh.joutiya.ma (public).
progress "host key $(cut -d ' ' -f 1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
progress "done $(date -u +%FT%TZ)"
