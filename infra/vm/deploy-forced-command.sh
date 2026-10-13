#!/usr/bin/env bash
# Forced command of the deploy users (§6), installed as /usr/local/sbin/joutiya-deploy (root,
# 0755) and reached only through sudo (infra/vm/sudoers.joutiya-deploy). The environment comes
# from sshd's ForceCommand, never from the client; the client only picks an action:
#
#   deploy-staging (CI key):  load <release>      image tarball (docker save | zstd) on stdin
#                             rollback | status
#   deploy-prod (owner key):  promote <release> <web image id> <worker image id>
#                             rollback | status
#
# Production can only run images already loaded and running in staging, pinned by image ID.
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly ENV_NAME="${1:-}"
readonly COMPOSE_DIR=/opt/joutiya/docker
readonly STATE_DIR=/var/lib/joutiya
readonly MAX_IMAGE_BYTES=$((3 * 1024 * 1024 * 1024))
readonly KEEP_RELEASES=4

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; logger -t joutiya-deploy -- "${ENV_NAME}: $*" || true; }
die() { log "error: $*"; exit 1; }

[[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "prod" ]] || die "unknown environment"

# Split the client's request on spaces only; no shell ever sees it.
read -r -a ARGS <<< "${SSH_ORIGINAL_COMMAND:-status}"
readonly ACTION="${ARGS[0]:-status}"

valid_release() { [[ "$1" =~ ^[0-9a-f]{12,40}$ ]]; }
valid_image_id() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }
image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
current_release() { cat "$STATE_DIR/$1.release" 2>/dev/null || true; }

compose() {
  local env="$1" release="$2"
  shift 2
  APP_ENV="$env" RELEASE="$release" docker compose \
    --project-directory "$COMPOSE_DIR" \
    -f "$COMPOSE_DIR/compose.yml" -f "$COMPOSE_DIR/compose.$env.yml" "$@"
}

# Starts a release, waits for health, rolls back to the previous release on failure.
start() {
  local env="$1" release="$2" previous
  previous="$(current_release "$env")"
  log "starting $release (previous: ${previous:-none})"
  if compose "$env" "$release" up -d --remove-orphans --wait --wait-timeout 240; then
    if [[ -n "$previous" && "$previous" != "$release" ]]; then echo "$previous" > "$STATE_DIR/$env.previous"; fi
    echo "$release" > "$STATE_DIR/$env.release"
    log "running $release"
    return 0
  fi
  if [[ -n "$previous" && "$previous" != "$release" ]]; then
    log "health check failed: rolling back to $previous"
    compose "$env" "$previous" up -d --remove-orphans --wait --wait-timeout 240 || log "rollback failed too"
  fi
  die "release $release did not become healthy"
}

# Removes Joutiya images no environment uses, beyond the most recent ones.
prune() {
  local keep
  keep="$(cat "$STATE_DIR"/*.release "$STATE_DIR"/*.previous 2>/dev/null | sort -u || true)"
  docker image ls --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
    | awk '$1 ~ /^joutiya-(web|worker):/' | sort -k2 -r | awk '{print $1}' \
    | while read -r ref; do
        local tag="${ref#*:}"
        if grep -qx "$tag" <<< "$keep"; then continue; fi
        echo "$ref"
      done | tail -n +"$((KEEP_RELEASES * 2 + 1))" | xargs -r docker image rm >/dev/null 2>&1 || true
}

purge_cdn_cache() {
  # Production HTML is cached by Cloudflare: a new release must not serve old chunk URLs.
  local file="/etc/joutiya/prod/deploy.env"
  [[ -r "$file" ]] || { log "no $file: Cloudflare cache not purged"; return 0; }
  # shellcheck disable=SC1090
  source "$file"
  [[ -n "${CF_ZONE_ID:-}" && -n "${CF_PURGE_TOKEN:-}" ]] || { log "Cloudflare purge not configured"; return 0; }
  if curl -fsS --max-time 20 -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CF_PURGE_TOKEN}" -H "Content-Type: application/json" \
    --data '{"purge_everything":true}' > /dev/null; then
    log "Cloudflare cache purged"
  else
    log "warning: Cloudflare cache purge failed"
  fi
}

status() {
  local env release
  printf '{'
  for env in staging prod; do
    release="$(current_release "$env")"
    printf '"%s":{"release":"%s","web":"%s","worker":"%s"}' "$env" "$release" \
      "$( [[ -n "$release" ]] && image_id "joutiya-web:$release")" \
      "$( [[ -n "$release" ]] && image_id "joutiya-worker:$release")"
    [[ "$env" == "staging" ]] && printf ','
  done
  printf '}\n'
}

load() {
  [[ "$ENV_NAME" == "staging" ]] || die "load is reserved to staging"
  local release="${ARGS[1]:-}" output loaded
  valid_release "$release" || die "invalid release"
  output="$(head -c "$MAX_IMAGE_BYTES" | zstd -dc | docker load)" || die "docker load failed"
  loaded="$(sed -n 's/^Loaded image: //p' <<< "$output" | sort)"
  local expected
  expected="$(printf 'joutiya-web:%s\njoutiya-worker:%s\n' "$release" "$release" | sort)"
  if [[ "$loaded" != "$expected" ]]; then
    # Anything else than the two expected images is removed, never run.
    xargs -r docker image rm <<< "$loaded" >/dev/null 2>&1 || true
    die "unexpected images in the tarball"
  fi
  start staging "$release"
  prune
}

promote() {
  [[ "$ENV_NAME" == "prod" ]] || die "promote is reserved to production"
  local release="${ARGS[1]:-}" web="${ARGS[2]:-}" worker="${ARGS[3]:-}"
  valid_release "$release" || die "invalid release"
  valid_image_id "$web" && valid_image_id "$worker" || die "invalid image id"
  [[ "$(current_release staging)" == "$release" ]] || die "$release is not the release running in staging"
  [[ "$(image_id "joutiya-web:$release")" == "$web" ]] || die "web image id mismatch"
  [[ "$(image_id "joutiya-worker:$release")" == "$worker" ]] || die "worker image id mismatch"
  start prod "$release"
  purge_cdn_cache
}

rollback() {
  local previous
  previous="$(cat "$STATE_DIR/$ENV_NAME.previous" 2>/dev/null || true)"
  valid_release "$previous" || die "no previous release"
  [[ -n "$(image_id "joutiya-web:$previous")" ]] || die "previous images were pruned"
  start "$ENV_NAME" "$previous"
  [[ "$ENV_NAME" == "prod" ]] && purge_cdn_cache
  return 0
}

mkdir -p "$STATE_DIR"
exec 9> "$STATE_DIR/deploy.lock"
flock -w 600 9 || die "another deployment is running"

case "$ACTION" in
  load) load ;;
  promote) promote ;;
  rollback) rollback ;;
  status) status ;;
  *) die "unknown action" ;;
esac
