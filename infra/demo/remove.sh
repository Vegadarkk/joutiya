#!/bin/bash
# Removes the staging demo listings (scripts/seed-demo.ts, docs/staging-demo.md), before launch.
# Run as root on joutiya-vm: node scripts/oracle-vm.ts run infra/demo/remove.sh [--apply]
set -euo pipefail
id="$(docker ps -q --filter label=com.docker.compose.project=joutiya-staging --filter label=com.docker.compose.service=worker)"
[[ -n "$id" ]] || { echo "staging worker: not running"; exit 1; }
docker exec "$id" node dist/worker/seed-demo.mjs --remove --apply 2>&1 | tail -n 30
