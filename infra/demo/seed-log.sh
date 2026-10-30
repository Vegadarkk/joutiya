#!/bin/bash
# Last lines of the detached example seed (infra/demo/seed.sh); ends with "exit <code>" once done.
# Run as root on joutiya-vm: node scripts/oracle-vm.ts run infra/demo/seed-log.sh [--apply]
set -euo pipefail
id="$(docker ps -q --filter label=com.docker.compose.project=joutiya-staging --filter label=com.docker.compose.service=worker)"
[[ -n "$id" ]] || { echo "staging worker: not running"; exit 1; }
docker exec "$id" sh -c 'tail -n 30 /tmp/seed-demo.log 2>/dev/null || echo "no seed log"'
