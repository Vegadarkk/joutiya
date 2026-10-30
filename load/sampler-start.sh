#!/bin/bash
# Load test (D17): starts a detached 10-minute CPU sampler, then returns. Every 5 s it appends the host's
# /proc/stat and each staging container's cgroup CPU usage to /var/tmp/joutiya-load/raw (no secret).
# Run as root on joutiya-vm just before the Load test workflow:
# node scripts/oracle-vm.ts run load/sampler-start.sh [--apply]; read it with load/sampler-read.sh
# (docs/lancement/charge-procedure.md). Detached because Run Command loses the output of a command
# that runs for several minutes (seen on 30 Oct 2026 with `oracle-vm.ts cpu --minutes=9`).
set -euo pipefail
d=/var/tmp/joutiya-load; rm -rf "$d"; install -d -m 0700 "$d"
cat > "$d/sample.sh" <<'S'
#!/bin/bash
d=/var/tmp/joutiya-load
for _ in $(seq 120); do
  t=$(date +%s)
  echo "$t host $(grep '^cpu ' /proc/stat | awk '{print $2+$3+$4+$7+$8+$9, $5+$6}')" >> "$d/raw"
  for id in $(docker ps -q --filter label=com.docker.compose.project=joutiya-staging); do
    name=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id")
    f=$(ls -d /sys/fs/cgroup/system.slice/docker-${id}*.scope 2>/dev/null | head -1)
    [[ -n "$f" ]] && echo "$t $name $(awk '/^usage_usec/{print $2}' "$f/cpu.stat")" >> "$d/raw"
  done
  sleep 5
done
echo done >> "$d/status"
S
chmod 0700 "$d/sample.sh"
nohup setsid "$d/sample.sh" > /dev/null 2>&1 < /dev/null &
echo "sampler started $(date -u +%H:%M:%S)"
