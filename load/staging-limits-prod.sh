#!/bin/bash
# Load test (D17): the running staging containers get the production limits of compose.prod.yml.
# Run as root on joutiya-vm: node scripts/oracle-vm.ts run load/staging-limits-prod.sh [--apply]
# (docs/lancement/charge-procedure.md). The limits are those of docker/compose.prod.yml
# (tests/unit/loadtest-limits.test.ts). The next deploy of staging recreates the containers with
# the limits of compose.staging.yml anyway.
set -euo pipefail
limit() {
  local service="$1" cpus="$2" memory="$3" id
  id="$(docker ps -q --filter label=com.docker.compose.project=joutiya-staging --filter "label=com.docker.compose.service=$service")"
  [[ -n "$id" ]] || { echo "$service: not running"; exit 1; }
  docker update --cpus "$cpus" --memory "$memory" --memory-swap "$memory" "$id" > /dev/null
  echo "$service: cpus $cpus, memory $memory"
}
limit web 1.5 1536M
limit worker 0.75 1024M
limit valkey-queue 0.5 320M
limit valkey-ratelimit 0.25 128M
limit meilisearch 1.0 2048M
limit cloudflared 0.5 192M
