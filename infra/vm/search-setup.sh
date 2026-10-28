#!/usr/bin/env bash
# Meilisearch of one environment (phase 4): the index and the app's two scoped keys, made by
# scripts/search-setup.ts in the worker image and written to app.env with MEILI_URL, then web and
# worker recreated so that they read them. A first start runs without the three (search answers 503).
# Run as root through Run Command once a release with Meilisearch runs, and after a rebuild
# (`node scripts/oracle-vm.ts search-setup <env> --apply`):
#
#   joutiya-search-setup <staging|prod> [--reindex=<max Firestore reads>]
#
# The master key goes from meilisearch.env to the one-off worker container as an environment
# variable, never an argument; the keys reach app.env without being printed. --reindex then rebuilds
# the index from Firestore (scripts/reindex-search.ts), for a new or restored VM.
set -euo pipefail

readonly ENV_NAME="${1:-}" REINDEX="${2:-}"
if [[ "$ENV_NAME" != staging && "$ENV_NAME" != prod ]] || [[ -n "$REINDEX" && ! "$REINDEX" =~ ^--reindex=[0-9]+$ ]]; then
  echo "usage: joutiya-search-setup <staging|prod> [--reindex=<max reads>]" >&2
  exit 2
fi
# The two overrides serve the unit tests only (tests/unit/search-setup.test.ts).
readonly DIR="${JOUTIYA_ETC_DIR:-/etc/joutiya}/$ENV_NAME" STATE_DIR="${JOUTIYA_STATE_DIR:-/var/lib/joutiya}"
readonly COMPOSE_DIR=/opt/joutiya/docker
RELEASE="$(cat "$STATE_DIR/$ENV_NAME.release" 2>/dev/null || true)"
[[ "$RELEASE" =~ ^[0-9a-f]{12,40}$ ]] || { echo "$ENV_NAME runs no release" >&2; exit 1; }

compose() {
  APP_ENV="$ENV_NAME" RELEASE="$RELEASE" docker compose --project-directory "$COMPOSE_DIR" \
    -f "$COMPOSE_DIR/compose.yml" -f "$COMPOSE_DIR/compose.$ENV_NAME.yml" "$@"
}

MEILI_MASTER_KEY="$(sed -n 's/^MEILI_MASTER_KEY=//p' "$DIR/meilisearch.env" 2>/dev/null || true)"
[[ -n "$MEILI_MASTER_KEY" ]] || { echo "$DIR/meilisearch.env holds no MEILI_MASTER_KEY: run oracle-vm.ts env first" >&2; exit 1; }
export MEILI_MASTER_KEY

compose up -d --no-deps --wait --wait-timeout 120 meilisearch

out="$(mktemp -d "$STATE_DIR/search-setup.XXXXXX")"
new=""
trap 'rm -rf "$out" "$new"' EXIT
# The worker runs as uid 1000 in the environment's group: it writes the keys there, root reads them.
chgrp "joutiya-$ENV_NAME" "$out"
chmod 0770 "$out"
compose run --rm --no-deps -T -e MEILI_MASTER_KEY -v "$out:/out" worker \
  node dist/worker/search-setup.mjs --url http://meilisearch:7700 --write-env /out/keys.env --apply

keys="$(grep -E '^MEILI_(SEARCH|INDEX)_KEY=[A-Za-z0-9_-]+$' "$out/keys.env" || true)"
[[ "$(grep -c . <<< "$keys")" -eq 2 ]] || { echo "search-setup left no usable keys: app.env unchanged" >&2; exit 1; }
umask 077
new="$(mktemp "$DIR/.app.env.XXXXXX")"
grep -v -E '^MEILI_(URL|SEARCH_KEY|INDEX_KEY)=' "$DIR/app.env" > "$new" || [[ $? -eq 1 ]]
printf '%s\n' "$keys" "MEILI_URL=http://meilisearch:7700" >> "$new"
chmod 0600 "$new"
mv -f "$new" "$DIR/app.env"
new=""
echo "app.env: MEILI_URL, MEILI_SEARCH_KEY and MEILI_INDEX_KEY set (values not shown)"

# Compose reads app.env only when it creates a container.
compose up -d --no-deps --force-recreate --wait --wait-timeout 240 web worker
echo "web and worker recreated"
if [[ -n "$REINDEX" ]]; then
  compose exec -T worker node dist/worker/reindex-search.mjs --apply --max-reads "${REINDEX#--reindex=}"
fi
