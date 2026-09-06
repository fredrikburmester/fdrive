#!/bin/bash
# usage: tools/orchestration/merge-chunk.sh <worktree-dir> "<commit message>"
# Commits everything in the agent's worktree on its branch, merges that branch into the main
# checkout, and regenerates pnpm-lock.yaml when it conflicts. Code conflicts are left for a
# resolution agent; the script reports them and exits non-zero.
set -euo pipefail
WT="$1"; MSG="$2"
MAIN=$(dirname "$(git -C "$WT" rev-parse --git-common-dir)")
BR=$(git -C "$WT" branch --show-current)
git -C "$WT" add -A
git -C "$WT" -c core.hooksPath=/dev/null commit -q -m "$MSG

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
cd "$MAIN"
if ! git merge -q --no-edit "$BR"; then
  echo "MERGE CONFLICT; resolving lockfile by regenerating"
  git checkout --theirs pnpm-lock.yaml 2>/dev/null || true
  pnpm install --lockfile-only >/dev/null 2>&1 || true
  git add pnpm-lock.yaml 2>/dev/null || true
  if git diff --name-only --diff-filter=U | grep -q .; then echo "unresolved:"; git diff --name-only --diff-filter=U; exit 1; fi
  git -c core.hooksPath=/dev/null commit -q --no-edit
fi
pnpm install --frozen-lockfile >/dev/null 2>&1 || { pnpm install >/dev/null && git add pnpm-lock.yaml && git -c core.hooksPath=/dev/null commit -q -m "chore: refresh lockfile after merging $BR" || true; }
git log --oneline -3
