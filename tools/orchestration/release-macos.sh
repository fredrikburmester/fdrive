#!/bin/bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
if [[ ${1:-} == --help || $# -lt 1 ]]; then
  printf '%s\n' 'usage: release-macos.sh checkout {check|release} --version X.Y.Z --build N --output directory [--team TEAM]'
  exit 0
fi
CHECKOUT=$1
shift
bash "$SCRIPT_DIR/run-in-checkout.sh" "$CHECKOUT" --lock -- \
  python3 "$SCRIPT_DIR/../macos/release.py" "$@"
