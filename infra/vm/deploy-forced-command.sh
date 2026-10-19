#!/usr/bin/env bash
# Forced command of the deployments (§6), installed as /usr/local/sbin/joutiya-deploy (root,
# 0755). Staging: the CI's deploy-staging user reaches it only through sudo
# (infra/vm/sudoers.joutiya-deploy), its environment set by sshd's ForceCommand. Production: root
# runs it through OCI Run Command (scripts/oracle-vm.ts). The caller only picks an action:
#
#   staging (CI key):          load <release>      image tarball (docker save | zstd) on stdin
#                              rollback | status
#   prod (Run Command, root):  promote <release> <web image id> <worker image id>
#                              rollback | status
#
# Production can only run images already loaded and running in staging, pinned by image ID, and
# the staging key can never load a tarball that would move the tags of a production release.
# `load` records the sha256 of each release's tarball; `oracle-vm.ts promote` compares it with the
# one the CI recorded on the commit, so a leaked staging key cannot get its own images promoted.
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
tarball_digest() { cat "$STATE_DIR/tarballs/$1" 2>/dev/null || true; }

compose() {
  local env="$1" release="$2"
  shift 2
  APP_ENV="$env" RELEASE="$release" docker compose \
    --project-directory "$COMPOSE_DIR" \
    -f "$COMPOSE_DIR/compose.yml" -f "$COMPOSE_DIR/compose.$env.yml" "$@"
}

# Starts every service of a release, then waits for web and worker only: an unhealthy Meilisearch
# (phase 4) means search answers 503, never a rolled-back release (D2). The Valkey instances are
# waited for by the first `up` already (depends_on: service_healthy).
up_release() {
  local env="$1" release="$2"
  compose "$env" "$release" up -d --remove-orphans \
    && compose "$env" "$release" up -d --no-deps --no-recreate --wait --wait-timeout 240 web worker
}

# Starts a release, waits for health, rolls back to the previous release on failure.
start() {
  local env="$1" release="$2" previous
  previous="$(current_release "$env")"
  log "starting $release (previous: ${previous:-none})"
  if up_release "$env" "$release"; then
    if [[ -n "$previous" && "$previous" != "$release" ]]; then echo "$previous" > "$STATE_DIR/$env.previous"; fi
    echo "$release" > "$STATE_DIR/$env.release"
    log "running $release"
    return 0
  fi
  if [[ -n "$previous" && "$previous" != "$release" ]]; then
    log "health check failed: rolling back to $previous"
    up_release "$env" "$previous" || log "rollback failed too"
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
  local record
  for record in "$STATE_DIR"/tarballs/*; do
    if [[ -f "$record" && -z "$(image_id "joutiya-web:${record##*/}")" ]]; then rm -f "$record"; fi
  done
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
    printf '"%s":{"release":"%s","web":"%s","worker":"%s","tarball":"%s"}' "$env" "$release" \
      "$( [[ -n "$release" ]] && image_id "joutiya-web:$release")" \
      "$( [[ -n "$release" ]] && image_id "joutiya-worker:$release")" \
      "$( [[ -n "$release" ]] && tarball_digest "$release")"
    [[ "$env" == "staging" ]] && printf ','
  done
  printf '}\n'
}

# Image names a `docker save` tarball would create, from every file `docker load` takes them from:
# manifest.json (RepoTags), index.json (OCI annotations) and the legacy repositories file.
tarball_names() {
  python3 - "$1" << 'PY'
import json, sys, tarfile
names = set()
with tarfile.open(sys.argv[1]) as tar:
    def read(name):
        try:
            member = tar.getmember(name)
        except KeyError:
            return None
        return json.load(tar.extractfile(member)) if member.isfile() else None
    for entry in read("manifest.json") or []:
        names.update(entry.get("RepoTags") or [])
    for descriptor in (read("index.json") or {}).get("manifests") or []:
        for key, value in (descriptor.get("annotations") or {}).items():
            if key in ("io.containerd.image.name", "org.opencontainers.image.ref.name"):
                names.add(value)
    for repository, tags in (read("repositories") or {}).items():
        names.update(f"{repository}:{tag}" for tag in tags)
print("\n".join(sorted(names)))
PY
}

load() {
  [[ "$ENV_NAME" == "staging" ]] || die "load is reserved to staging"
  local release="${ARGS[1]:-}" tarball digest names name output loaded
  valid_release "$release" || die "invalid release"
  # Production runs its images by tag: loading one of its releases again would replace them.
  if [[ "$release" == "$(current_release prod)" || "$release" == "$(cat "$STATE_DIR/prod.previous" 2>/dev/null || true)" ]]; then
    die "$release is a production release"
  fi
  tarball="$(mktemp -p "$STATE_DIR" load.XXXXXX)"
  # shellcheck disable=SC2064 # expanded now: $tarball is local to this function
  trap "rm -f '$tarball'" EXIT
  head -c "$MAX_IMAGE_BYTES" | zstd -dc | head -c "$MAX_IMAGE_BYTES" > "$tarball" || die "unreadable or oversized tarball"
  digest="sha256:$(sha256sum "$tarball" | cut -d ' ' -f 1)"
  # Names are checked before docker load: once loaded, a tag already points to the new image.
  names="$(tarball_names "$tarball")" || die "unreadable tarball"
  while read -r name; do
    [[ -n "$name" ]] || continue
    case "${name#docker.io/library/}" in
      "joutiya-web:$release" | "joutiya-worker:$release" | "$release") ;;
      *) die "unexpected image name in the tarball" ;;
    esac
  done <<< "$names"
  for name in joutiya-web joutiya-worker; do
    grep -qx -e "$name:$release" -e "docker.io/library/$name:$release" <<< "$names" || die "$name:$release is missing from the tarball"
  done
  output="$(docker load -i "$tarball")" || die "docker load failed"
  rm -f "$tarball"
  loaded="$(sed -n 's/^Loaded image: //p' <<< "$output" | sed 's|^docker.io/library/||' | sort)"
  if [[ "$loaded" != "$(printf 'joutiya-web:%s\njoutiya-worker:%s' "$release" "$release")" ]]; then
    # Anything else than the two expected images is removed, never run.
    xargs -r docker image rm <<< "$loaded" >/dev/null 2>&1 || true
    die "unexpected images in the tarball"
  fi
  # The tags of this release now name this tarball's images, whether or not they start.
  install -d -m 0700 "$STATE_DIR/tarballs"
  echo "$digest" > "$STATE_DIR/tarballs/$release"
  start staging "$release"
  prune
}

promote() {
  [[ "$ENV_NAME" == "prod" ]] || die "promote is reserved to production"
  local release="${ARGS[1]:-}" web="${ARGS[2]:-}" worker="${ARGS[3]:-}"
  valid_release "$release" || die "invalid release"
  if ! valid_image_id "$web" || ! valid_image_id "$worker"; then die "invalid image id"; fi
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
