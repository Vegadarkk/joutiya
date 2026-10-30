#!/bin/bash
# Example listings on staging (scripts/seed-demo.ts, docs/staging-demo.md): writes or refreshes them from
# the staging worker container. Run as root on joutiya-vm: node scripts/oracle-vm.ts run infra/demo/seed.sh [--apply]
# A full seed outlasts Run Command (killed at ~9 min): it runs detached, its log at /tmp/seed-demo.log in
# the worker (infra/demo/seed-log.sh).
set -euo pipefail
id="$(docker ps -q --filter label=com.docker.compose.project=joutiya-staging --filter label=com.docker.compose.service=worker)"
[[ -n "$id" ]] || { echo "staging worker: not running"; exit 1; }
# [.] keeps this grep's own command line from matching.
if docker exec "$id" sh -c 'grep -qs "seed-demo[.]mjs" /proc/[0-9]*/cmdline'; then echo "seed already running"; exit 1; fi
docker exec -d "$id" sh -c 'node dist/worker/seed-demo.mjs --apply > /tmp/seed-demo.log 2>&1; echo "exit $?" >> /tmp/seed-demo.log'
echo "seed started in the staging worker; progress: node scripts/oracle-vm.ts run infra/demo/seed-log.sh --apply"
