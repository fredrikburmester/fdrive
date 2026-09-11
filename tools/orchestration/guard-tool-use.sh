#!/bin/bash
# PreToolUse guard entry point. Reads the hook payload on stdin; exit 2 blocks the call.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 "$SCRIPT_DIR/guard-tool-use.py"
