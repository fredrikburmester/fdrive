#!/bin/bash
# usage: ALLOWED="<allowed path-prefix regex>" review-chunk.sh <worktree-dir>
# Checks the worker delta, conflicts, and stash. A working-tree baseline is transfer-only.
# Root pnpm-lock.yaml is always allowed. Scope/stash/conflict violations fail review.
set -euo pipefail

fail() { printf 'review-chunk: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 ]] || fail 'usage: ALLOWED="<regex>" review-chunk.sh <worktree-dir>'
[[ -n ${ALLOWED:-} ]] || fail 'ALLOWED must be a nonempty path-prefix regex'
SCOPE="^(${ALLOWED})"
if [[ '' =~ $SCOPE ]]; then
  :
else
  [[ $? -eq 1 ]] || fail 'ALLOWED is not a valid extended regular expression'
fi
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
ARGS=(review --allowed "$ALLOWED")
exec python3 "$SCRIPT_DIR/transfer-checkout.py" "${ARGS[@]}" "$1"
