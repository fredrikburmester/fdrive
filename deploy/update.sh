#!/bin/bash
# Pull the latest fdrive and rebuild the stack in place. Safe to re-run: with nothing
# new to pull the build reuses cached layers. Runs ./preflight.sh right before
# `up`, so a leftover change-me placeholder, an unknown FDRIVE_* key, or a
# malformed FDRIVE_HOME_TEMPLATE in deploy/.env stops the update instead of
# deploying a silently misconfigured stack.
#
# Run it from anywhere, including through a symlink; it resolves its own real
# path and changes into the repo's deploy directory itself.
#
# Environment (optional; selectors and network addresses also read deploy/.env):
#   FDRIVE_COMPOSE_FILES  extra compose files, space separated, added after compose.yaml
#                         (for example "compose.sftpgo-network.yaml").
#                         Every file you normally pass with -f must be listed, or the
#                         services it defines are silently detached or left on old images.
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
cd "$repo"

echo "==> before: $(git log --oneline -1)"
git pull --ff-only
echo "==> after:  $(git log --oneline -1)"

# Capture the source being built, after pulling. Bake it into the API image.
FDRIVE_BUILD_REVISION="$(git rev-parse HEAD)"
export FDRIVE_BUILD_REVISION

cd "$repo/deploy"
# Read only stack selectors and network addresses needed for startup output
# and the health check; never source .env as executable shell code.
if [[ -f .env ]]; then
  for key in FDRIVE_COMPOSE_FILES FDRIVE_PROFILES FDRIVE_HTTP_BIND FDRIVE_HTTP_PORT FDRIVE_READY_TIMEOUT_SECONDS; do
    if [[ -z "${!key:-}" ]]; then
      # `|| true` keeps an absent key from aborting the script under pipefail.
      value="$({ grep -E "^${key}=" .env || true; } | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
      [[ -n "$value" ]] && export "$key=$value"
    fi
  done
fi
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
  echo "==> native ARM64 TEI base"
  ./build-arm64-runtime.sh
  break
done

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
