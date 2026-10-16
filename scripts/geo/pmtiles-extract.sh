#!/usr/bin/env bash
# Extracts the Morocco basemap (design D10) from the latest Protomaps daily planet build with go-pmtiles.
# Everything lands in a fresh scratch directory, never in the repo (~63 MB); the coordinator uploads the
# result to the media bucket as `maps/morocco.pmtiles` (Cache-Control immutable, see research A6).
#
#   scripts/geo/pmtiles-extract.sh [--out <dir>] [--build YYYYMMDD] [--maxzoom 12] [--dry-run]
#
# Defaults: --out = a new directory under ${TMPDIR:-/tmp}; --build = latest key of
# https://build-metadata.protomaps.dev/builds.json; bbox = MOROCCO_BBOX (src/config/regions.ts).
# go-pmtiles v1.31.2 is downloaded from the GitHub release for the current Linux architecture
# (x86_64 or arm64) and verified by sha256 when the digest is known; the tarball stays in the scratch dir.
# Requires: bash, curl, tar, sha256sum (coreutils).

set -euo pipefail

PMTILES_VERSION="1.31.2"
# Release asset digests (x86_64 measured 2026-10-16; add arm64 once measured).
declare -A SHA256=(
  ["x86_64"]="3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f"
)
BBOX="-17.3,20.7,-0.9,36.1"
MAXZOOM="12"
BUILD=""
OUT=""
DRY_RUN=""

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --maxzoom) MAXZOOM="$2"; shift 2 ;;
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

case "$(uname -s)" in
  Linux) ;;
  *) echo "this script supports Linux only (use the protomaps/go-pmtiles Docker image elsewhere)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ -z "$OUT" ]; then
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/joutiya-pmtiles.XXXXXX")"
else
  mkdir -p "$OUT"
fi
OUT="$(cd "$OUT" && pwd)"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "$OUT" in
  "$REPO_ROOT"/*) echo "refusing to write inside the repository: $OUT" >&2; exit 1 ;;
esac
echo "scratch directory: $OUT"

if [ -z "$BUILD" ]; then
  # Keys look like "20261015.pmtiles"; the newest date sorts last.
  BUILD="$(curl -sSfL --retry 3 https://build-metadata.protomaps.dev/builds.json | grep -o '"[0-9]\{8\}\.pmtiles"' | tr -d '"' | sed 's/\.pmtiles$//' | sort | tail -n 1)"
  [ -n "$BUILD" ] || { echo "could not read the builds index" >&2; exit 1; }
fi
echo "planet build: $BUILD"

TARBALL="$OUT/go-pmtiles_${PMTILES_VERSION}_Linux_${ARCH}.tar.gz"
curl -sSfL --retry 3 -o "$TARBALL" \
  "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${ARCH}.tar.gz"
DIGEST="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
if [ -n "${SHA256[$ARCH]:-}" ]; then
  [ "$DIGEST" = "${SHA256[$ARCH]}" ] || { echo "sha256 mismatch for $TARBALL: $DIGEST" >&2; exit 1; }
  echo "go-pmtiles tarball sha256 verified"
else
  echo "go-pmtiles tarball sha256 (unverified for $ARCH, record it in this script): $DIGEST"
fi
mkdir -p "$OUT/bin"
tar -xzf "$TARBALL" -C "$OUT/bin" pmtiles
PMTILES="$OUT/bin/pmtiles"
"$PMTILES" version

ARCHIVE="$OUT/morocco.pmtiles"
# shellcheck disable=SC2086 # DRY_RUN is empty or a single flag.
"$PMTILES" extract "https://build.protomaps.com/${BUILD}.pmtiles" "$ARCHIVE" --bbox="$BBOX" --maxzoom="$MAXZOOM" $DRY_RUN

if [ -z "$DRY_RUN" ]; then
  echo
  "$PMTILES" show "$ARCHIVE" | grep -E '^(bounds|max zoom|tile entries count|version|planetiler:osm:osmosisreplicationtime)'
  echo "size: $(stat -c %s "$ARCHIVE") bytes"
  echo "sha256: $(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
  echo "upload as maps/morocco.pmtiles (Content-Type application/octet-stream, Cache-Control public, max-age=31536000, immutable)"
fi
