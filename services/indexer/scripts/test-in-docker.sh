#!/usr/bin/env bash
# Runs the full pytest suite (including the Linux-only inotify watcher tests)
# inside the service's own Docker image, on a development machine that is not
# Linux (macOS, Windows). The container gets the host's Docker socket so
# testcontainers can start its own Postgres containers from inside.
# The container joins the socket's owning group so the indexer user can reach
# it: Docker Desktop's socket belongs to group 0, a Linux host's (including
# GitHub's runners) to the `docker` group, read from the socket itself here.
# Override with FDRIVE_TEST_DOCKER_GID when neither applies.
#
# Usage: services/indexer/scripts/test-in-docker.sh [pytest args...]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE_TAG="fdrive-indexer-test:local"
SOCKET=/var/run/docker.sock
if [[ -z "${FDRIVE_TEST_DOCKER_GID:-}" ]]; then
  # Only a Linux host's socket is the one mounted into the container; Docker
  # Desktop mounts its VM's socket (group 0), whatever the macOS path says.
  if [[ "$(uname -s)" == "Linux" ]]; then
    FDRIVE_TEST_DOCKER_GID="$(stat -c %g "$SOCKET" 2>/dev/null || echo 0)"
  else
    FDRIVE_TEST_DOCKER_GID=0
  fi
fi

docker build -t "$IMAGE_TAG" .

docker run --rm \
  --group-add "$FDRIVE_TEST_DOCKER_GID" \
  -v "$SOCKET":/var/run/docker.sock \
  -v "$(pwd)/tests:/app/tests:ro" \
  -v "$(pwd)/scripts:/app/scripts:ro" \
  -v "$(pwd)/pyproject.toml:/app/pyproject.toml:ro" \
  -v "$(pwd)/../../packages/db/drizzle:/repo-migrations:ro" \
  -e FDRIVE_DB_MIGRATIONS_DIR=/repo-migrations \
  -e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal \
  --add-host=host.docker.internal:host-gateway \
  --entrypoint pytest \
  "$IMAGE_TAG" \
  -q --cov=fdrive_indexer --cov-report=term-missing --cov-fail-under=95 "$@"
