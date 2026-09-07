#!/bin/bash
# Pull the latest fdrive and rebuild the stack in place. Safe to re-run: with nothing
# new to pull the build reuses cached layers.
#
# Run it from anywhere; it changes into the repo's deploy directory itself.
#
# Environment (all optional; the first two may also be set in deploy/.env):
#   FDRIVE_COMPOSE_FILES  extra compose files, space separated, added after compose.yaml
#                         (for example "compose.sftpgo-network.yaml compose.office.yaml").
#                         Every file you normally pass with -f must be listed, or the
#                         services it defines are silently detached or left on old images.
#   FDRIVE_PROFILES       compose profiles, space separated (for example "index office").
#   FDRIVE_HEALTH_URL     health URL to check afterwards; default derives from
#                         FDRIVE_HTTP_PORT (8090) on localhost.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

echo "==> before: $(git log --oneline -1)"
git pull --ff-only
echo "==> after:  $(git log --oneline -1)"

cd "$repo/deploy"
# The two selectors may also live in deploy/.env next to the other settings, so a
# host needs no wrapper script. Only these two keys are read; nothing else in the
# file is exported.
if [[ -f .env ]]; then
  for key in FDRIVE_COMPOSE_FILES FDRIVE_PROFILES; do
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
docker compose "${args[@]}" up -d --build --remove-orphans

echo
echo "==> containers"
docker compose "${args[@]}" ps --format '{{.Name}}\t{{.Status}}'
echo
health="${FDRIVE_HEALTH_URL:-http://127.0.0.1:${FDRIVE_HTTP_PORT:-8090}/api/v1/health}"
echo -n "==> api health (${health}): "
# --fail turns a 5xx into a nonzero exit, so a broken deploy fails this script.
curl -sf --max-time 10 "$health" || { echo "NOT HEALTHY"; exit 1; }
echo
