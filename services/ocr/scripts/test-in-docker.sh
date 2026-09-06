#!/usr/bin/env bash
# Runs the full pytest suite inside the service's own Docker image (a real
# Linux environment matching production, and the only place `ocrmypdf` and its
# Swedish/English tesseract data are actually installed). The container gets
# the host's Docker socket so testcontainers can start its own Postgres
# container from inside.
#
# Usage: services/ocr/scripts/test-in-docker.sh [pytest args...]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE_TAG="fdrive-ocr-test:local"

docker build -t "$IMAGE_TAG" .

# --user root: the image's default "app" user (uid 1000) cannot read
# /var/run/docker.sock (owned by root:docker on the host), which
# testcontainers needs to start its own Postgres container from inside. The
# runtime image (no override) still defaults to the non-root "app" user.
docker run --rm \
  --user root \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/tests:/app-src/tests:ro" \
  -v "$(pwd)/scripts:/app-src/scripts:ro" \
  -v "$(pwd)/pyproject.toml:/app-src/pyproject.toml:ro" \
  -v "$(pwd)/../../packages/db/drizzle:/repo-migrations:ro" \
  -e FDRIVE_DB_MIGRATIONS_DIR=/repo-migrations \
  -e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal \
  --add-host=host.docker.internal:host-gateway \
  --entrypoint /opt/ocr-venv/bin/pytest \
  "$IMAGE_TAG" \
  -q --cov=fdrive_ocr --cov-report=term-missing --cov-fail-under=95 "$@"
