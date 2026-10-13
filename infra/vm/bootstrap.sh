#!/bin/bash
# First boot of the Joutiya VM (Oracle Always Free Ampere A1, Ubuntu 24.04 aarch64), given as the
# cloud-init script when the instance is created (docs/phase-1.md). Copy this file to
# bootstrap.local.sh (ignored by Git), replace the placeholder with the token of joutiya-ssh-tunnel,
# and paste the copy; never commit the filled copy.
#
# Keeps the metadata service (which serves this script, token included) away from non-root users,
# starts the SSH tunnel, then installs Docker, swap and unattended upgrades. The VM is reached only
# through ssh.joutiya.ma (Cloudflare Access): the VCN has no ingress rule. Users, sshd, sudoers and Compose files come next, from
# `node scripts/deploy-prod.ts vm-sync` on the owner's machine.
set -euo pipefail

SSH_TUNNEL_TOKEN='__JOUTIYA_SSH_TUNNEL_TOKEN__'

install -m 0600 /dev/null /var/log/joutiya-bootstrap.log
exec >> /var/log/joutiya-bootstrap.log 2>&1
echo "bootstrap: start $(date -u +%FT%TZ)"
export DEBIAN_FRONTEND=noninteractive
if [[ "$SSH_TUNNEL_TOKEN" == __* ]]; then
  echo "bootstrap: the SSH tunnel token was not filled in"
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl zstd unattended-upgrades iptables-persistent

# Instance metadata (169.254.169.254) for root only, as Oracle recommends; saved with the image's
# own rules (Oracle images load /etc/iptables/rules.v4 at boot). Containers are blocked separately
# (infra/vm/joutiya-docker-firewall.service).
iptables -C OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j DROP 2> /dev/null \
  || iptables -I OUTPUT 1 -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j DROP
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

echo "bootstrap: done $(date -u +%FT%TZ)"
