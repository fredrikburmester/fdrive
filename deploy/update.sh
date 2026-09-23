#!/bin/bash
# Update fdrive in place: move this checkout to the release you run, pull that
# release's published images and restart the stack. Safe to re-run: with nothing
# new, the pull and restart change nothing. Runs ./preflight.sh right before
# `up`, so a leftover change-me placeholder, an unknown FDRIVE_* key, or a
# malformed FDRIVE_HOME_TEMPLATE in deploy/.env stops the update instead of
# deploying a silently misconfigured stack.
#
# Run it from anywhere, including through a symlink; it resolves its own real
# path and changes into the repo's deploy directory itself.
#
# Environment (optional; each is also read from deploy/.env):
#   FDRIVE_VERSION        release to run, for example 0.3.1. Unset or "latest" follows
#                         the newest release; "main" follows the main branch and its
#                         edge images.
#   FDRIVE_COMPOSE_FILES  extra compose files, space separated, added after compose.yaml
#                         (for example "compose.sftpgo-network.yaml").
#                         Every file you normally pass with -f must be listed, or the
#                         services it defines are silently detached or left on old images.
#                         With compose.build.yaml listed, images are built from this
#                         checkout instead of pulled.
#   FDRIVE_PROFILES       optional-overlay profiles, space separated (for example "collabora").
#   FDRIVE_HEALTH_URL     health URL to check afterwards; default derives from
#                         FDRIVE_HTTP_PORT (8090) on localhost.
#   FDRIVE_READY_TIMEOUT_SECONDS  enabled-subsystem startup timeout (default 1200).
set -euo pipefail

# Resolves this script's own real path through any symlinks (for example a
# `~/bin/update.sh -> /path/to/fdrive/deploy/update.sh` shortcut), so `repo`
# below is always the actual clone, not wherever a symlink happens to live.
# `readlink -f` (GNU coreutils, and modern macOS/BSD) does this in one call;
# the loop is the portable fallback for shells where it is unavailable.
resolve_script_path() {
  local source="${BASH_SOURCE[0]}"
  if command -v readlink >/dev/null 2>&1 && readlink -f "$source" >/dev/null 2>&1; then
    readlink -f "$source"
    return
  fi
  while [ -h "$source" ]; do
    local resolved_dir
    resolved_dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$resolved_dir/$source"
  done
  echo "$(cd -P "$(dirname "$source")" && pwd)/$(basename "$source")"
}

script_path="$(resolve_script_path)"
repo="$(cd "$(dirname "$script_path")/.." && pwd)"

cd "$repo/deploy"
# Read only the version, stack selectors and network addresses needed for
# startup output and the health check; never source .env as executable shell code.
if [[ -f .env ]]; then
  for key in FDRIVE_VERSION FDRIVE_COMPOSE_FILES FDRIVE_PROFILES FDRIVE_HTTP_BIND FDRIVE_HTTP_PORT FDRIVE_READY_TIMEOUT_SECONDS; do
    if [[ -z "${!key:-}" ]]; then
      # `|| true` keeps an absent key from aborting the script under pipefail.
      value="$({ grep -E "^${key}=" .env || true; } | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
      [[ -n "$value" ]] && export "$key=$value"
    fi
  done
fi
# Release tags are spelled v1.2.3; images and FDRIVE_VERSION use the bare number.
version="${FDRIVE_VERSION:-latest}"
version="${version#v}"

cd "$repo"
if [[ -z "${FDRIVE_UPDATE_CHECKED_OUT:-}" ]]; then
  echo "==> before: $(git log --oneline -1)"
  if [[ "$version" == main ]]; then
    git fetch --quiet origin main
    git checkout --quiet main
    git merge --quiet --ff-only origin/main
  else
    # --force: a tag re-pointed upstream replaces the local copy instead of
    # failing the fetch; this checkout mirrors the published releases.
    git fetch --quiet --force --tags origin
    if [[ "$version" == latest ]]; then
      tag="$(git tag --list 'v*' --sort=v:refname | { grep -Ex 'v[0-9]+\.[0-9]+\.[0-9]+' || true; } | tail -n 1)"
      if [[ -z "$tag" ]]; then
        echo "error: no fdrive release has been published yet; set FDRIVE_VERSION=main in deploy/.env to run the main branch" >&2
        exit 1
      fi
      version="${tag#v}"
    else
      tag="v$version"
      if ! git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
        echo "error: FDRIVE_VERSION=$version is not a release; see https://github.com/fredrikburmester/fdrive/releases" >&2
        exit 1
      fi
    fi
    git checkout --quiet --detach "$tag"
  fi
  echo "==> after:  $(git log --oneline -1)"
  # Finish with the update script of the version just checked out, which may
  # differ from the one that started.
  export FDRIVE_VERSION="$version" FDRIVE_UPDATE_CHECKED_OUT=1
  exec bash "$repo/deploy/update.sh"
fi

# Capture the source being run, after checking it out. Source builds
# (compose.build.yaml) bake the commit and release into the API image.
FDRIVE_BUILD_REVISION="$(git rev-parse HEAD)"
export FDRIVE_BUILD_REVISION FDRIVE_VERSION="$version"

cd "$repo/deploy"
args=(-f compose.yaml)
for file in ${FDRIVE_COMPOSE_FILES:-}; do
  args+=(-f "$file")
done
for profile in ${FDRIVE_PROFILES:-}; do
  args+=(--profile "$profile")
done

echo "==> preflight"
./preflight.sh

# The ARM64 override derives the managed runtime controller from a pinned
# upstream TEI build. Build that base here so ordinary `./update.sh` remains
# the complete deployment command; no feature selection touches Compose.
for file in ${FDRIVE_COMPOSE_FILES:-}; do
  [[ $file == "compose.arm64.yaml" ]] || continue
  echo "==> native ARM64 TEI base (the published images are native already; drop compose.arm64.yaml unless you build from source)"
  ./build-arm64-runtime.sh
  break
done

echo "==> images for fdrive ${FDRIVE_VERSION}"
if ! docker compose "${args[@]}" pull --ignore-buildable; then
  echo "error: could not pull the fdrive ${FDRIVE_VERSION} images, so the running containers were left unchanged. A release tagged within the last hour may still be publishing; run ./update.sh again later." >&2
  exit 1
fi
docker compose "${args[@]}" up -d --build --remove-orphans

echo
echo "==> containers"
docker compose "${args[@]}" ps --format '{{.Name}}\t{{.Status}}'
echo
echo "==> waiting for enabled subsystems"
docker compose "${args[@]}" exec -T \
  -e "FDRIVE_READY_TIMEOUT_SECONDS=${FDRIVE_READY_TIMEOUT_SECONDS:-1200}" \
  api node --input-type=module-typescript < "$repo/deploy/wait-ready.ts"

health_bind="${FDRIVE_HTTP_BIND:-127.0.0.1}"
[[ "$health_bind" == "0.0.0.0" ]] && health_bind=127.0.0.1
health="${FDRIVE_HEALTH_URL:-http://${health_bind}:${FDRIVE_HTTP_PORT:-8090}/api/v1/health}"
echo -n "==> api health (${health}): "
# --fail turns a 5xx into a nonzero exit, so a broken deploy fails this script.
curl -sf --max-time 10 "$health" || { echo "NOT HEALTHY"; exit 1; }
echo

if [[ "${FDRIVE_HTTP_BIND:-0.0.0.0}" == "0.0.0.0" ]]; then
  echo "==> From another device on your network, open http://<server-ip>:${FDRIVE_HTTP_PORT:-8090} to complete setup."
else
  echo "==> Open http://${FDRIVE_HTTP_BIND}:${FDRIVE_HTTP_PORT:-8090} in your browser to complete setup."
fi
