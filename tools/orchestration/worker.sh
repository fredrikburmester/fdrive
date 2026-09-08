#!/bin/bash
# External Gemini workers; the Python supervisor owns each child process group.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 "$SCRIPT_DIR/agy_worker.py" "$@"
