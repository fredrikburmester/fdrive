#!/bin/bash
# Build the pinned native TEI base used by compose.arm64.yaml's managed wrapper.
# This is a build-only helper: it never starts a container or downloads a model.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
base_image="fdrive-tei-arm64:4150561d42c4"
source_context="https://github.com/huggingface/text-embeddings-inference.git#4150561d42c495fe95f2aebb57fbb602c13ff4e6"

exec docker build \
  --platform linux/arm64 \
  --tag "$base_image" \
  --file Dockerfile-arm64 \
  --target http \
  "$source_context"
