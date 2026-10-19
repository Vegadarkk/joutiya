#!/bin/bash
# Boot check of joutiya-vm (test P1-1), run as root by OCI Run Command:
#   node scripts/oracle-vm.ts run infra/vm/check.sh --apply
# Modes, owners and names only: no secret is printed. Not installed on the VM (oracle-vm.ts).
set +e +o pipefail

echo "user $(id -un), $(uname -rm), up $(cut -d. -f1 /proc/uptime)s"
echo "active: $(systemctl is-active cloudflared docker joutiya-docker-firewall unattended-upgrades | tr '\n' ' ')"
echo "swap: $(swapon --show=NAME,SIZE --noheadings | tr -s ' ')"
echo "imds chain: $(iptables -S JOUTIYA-IMDS | grep -c RETURN) exemptions, first OUTPUT rule: $(iptables -S OUTPUT | sed -n 2p)"
stat -c '%a %U:%G %n' /etc/joutiya /etc/joutiya/ssh-tunnel.env /etc/joutiya/prod/tunnel.env /etc/joutiya/staging/tunnel.env /etc/sudoers.d/101-oracle-cloud-agent-run-command
echo "nobody -> metadata: $(sudo -u nobody curl -s -m 3 -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/id || echo blocked)"
echo "ssh listens: $(ss -Hltn 'sport = :22' | awk '{ printf "%s ", $4 }')"
u=$(getent passwd 1000 | cut -d: -f1)
if [[ -n "$u" ]]; then
  if sudo -l -U "$u" 2> /dev/null | grep -q 'may run'; then can=YES; else can=no; fi
  echo "uid 1000 (containers) = $u: groups $(id -nG "$u" | tr ' ' ,), shell $(getent passwd "$u" | cut -d: -f7), sudo $can"
fi
ud=$(grep -o '"user_data": "[^"]\{0,40\}' /run/cloud-init/instance-data.json | head -1)
case "$ud" in *redacted*) ud=redacted ;; "") ud=absent ;; *) ud=EXPOSED ;; esac
echo "instance-data user_data for non-root: $ud"
echo "per-boot copy: $(find /var/lib/cloud/scripts/per-boot/ -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null)"
grep -h 'joutiya-bootstrap:' /var/log/joutiya-bootstrap.log | grep -E 'WARNING|failed|done' | tail -n 4
df -h / | awk 'NR == 2 { print "disk: " $3 " used of " $2 }'
