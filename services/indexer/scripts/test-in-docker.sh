#!/usr/bin/env bash
# Runs the full pytest suite (including the Linux-only inotify watcher tests)
# inside the service's own Docker image, on a development machine that is not
# Linux (macOS, Windows). The container gets the host's Docker socket so
# testcontainers can start its own Postgres containers from inside.
# Docker Desktop's socket belongs to group 0; override FDRIVE_TEST_DOCKER_GID
# for a different Linux socket group. The tests still run as the indexer user.
#
# Usage: services/indexer/scripts/test-in-docker.sh [pytest args...]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE_TAG="fdrive-indexer-test:local"

docker build -t "$IMAGE_TAG" .

docker run --rm \
  --group-add "${FDRIVE_TEST_DOCKER_GID:-0}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
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
