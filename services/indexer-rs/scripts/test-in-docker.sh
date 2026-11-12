#!/usr/bin/env bash
# Runs the crate's tests (including the Linux-only inotify watcher tests) inside a Linux
# container, on a development machine that is not Linux (macOS, Windows).
#
# The crate is mounted read-only; named volumes keep target/, the cargo registry and the
# rustup toolchain between runs so reruns only rebuild what changed. The container gets the
# host's Docker socket so testcontainers can start its own Postgres containers, reached
# through host.docker.internal, and the repository's migrations at /repo-migrations.
#
# Usage: services/indexer-rs/scripts/test-in-docker.sh [cargo test args...]
#   e.g. scripts/test-in-docker.sh --lib watcher
# Set FDRIVE_TEST_CARGO=clippy to run `cargo clippy [args, default --all-targets] -- -D warnings`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUST_IMAGE=rust:1.99.0-trixie
IMAGE=fdrive-indexer-rs-test:1.99.0
VOLUME_PREFIX=fdrive-indexer-rs-test

# Docker Desktop's credential helper can hang a pull from a non-interactive shell.
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT

docker build -q -t "$IMAGE" - >/dev/null <<EOF
FROM $RUST_IMAGE
RUN apt-get update \\
 && apt-get install -y --no-install-recommends cmake libheif-dev libdav1d-dev \\
    pkg-config clang libclang-dev ffmpeg tesseract-ocr tesseract-ocr-eng tesseract-ocr-swe \\
 && rm -rf /var/lib/apt/lists/*
EOF

if [[ "${FDRIVE_TEST_CARGO:-test}" == "clippy" ]]; then
  [[ $# -gt 0 ]] || set -- --all-targets
  command=(cargo clippy "$@" -- -D warnings)
else
  command=(cargo test "$@")
fi

docker run --rm \
  -v "$(pwd)":/src:ro \
  -v "$(pwd)/../../packages/db/drizzle":/repo-migrations:ro \
  -v "$VOLUME_PREFIX-target":/target \
  -v "$VOLUME_PREFIX-registry":/usr/local/cargo/registry \
  -v "$VOLUME_PREFIX-rustup":/usr/local/rustup \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e CARGO_TARGET_DIR=/target \
  -e FDRIVE_DB_MIGRATIONS_DIR=/repo-migrations \
  -e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal \
  --add-host=host.docker.internal:host-gateway \
  -w /src \
  "$IMAGE" \
  "${command[@]}"
