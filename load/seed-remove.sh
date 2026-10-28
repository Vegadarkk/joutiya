#!/bin/bash
# After the load test: removes the data set (scripts/seed-loadtest.ts) from the staging worker container.
# Run as root on joutiya-vm: node scripts/oracle-vm.ts run load/seed-remove.sh [--apply]
# (docs/lancement/charge-procedure.md).
set -euo pipefail
id="$(docker ps -q --filter label=com.docker.compose.project=joutiya-staging --filter label=com.docker.compose.service=worker)"
[[ -n "$id" ]] || { echo "staging worker: not running"; exit 1; }
docker exec "$id" node dist/worker/seed-loadtest.mjs --remove --apply
