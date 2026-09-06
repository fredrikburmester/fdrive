#!/bin/bash
# usage: ALLOWED="<regex of allowed path prefixes>" tools/orchestration/review-chunk.sh <worktree-dir>
# Prints the worktree's status and flags files outside the allowed scope (lockfile excluded).
set -euo pipefail
WT="$1"
echo "== $WT ($(git -C "$WT" branch --show-current))"
git -C "$WT" status --short | head -80
echo "-- lockfile changed: $(git -C "$WT" status --short pnpm-lock.yaml | wc -l | tr -d ' ')"
echo "-- files outside allowed scope:"
git -C "$WT" status --short | awk '{print $2}' | grep -v -E "^(pnpm-lock.yaml|${ALLOWED:-__none__})" || echo "   none"
echo "-- stash entries (must be 0): $(git -C "$WT" stash list | wc -l | tr -d ' ')"
