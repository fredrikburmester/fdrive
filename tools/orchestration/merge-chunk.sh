#!/bin/bash
# usage: ALLOWED="<allowed path-prefix regex>" merge-chunk.sh <worktree-dir> "<commit message>" <target-checkout>
# Reviews and commits a chunk once, then merges with --no-ff into the target's current branch.
# Optional: CO_AUTHOR="Name <email>" adds an explicit Co-Authored-By trailer.
# Only a sole pnpm-lock.yaml conflict is regenerated automatically. Other merge errors and
# dependency failures stop the script for inspection; hooks remain enabled.
set -euo pipefail

fail() { printf 'merge-chunk: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 3 && -n $2 ]] || fail 'usage: ALLOWED="<regex>" merge-chunk.sh <worktree-dir> "<commit message>" <target-checkout>'
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
WT=$(git -C "$1" rev-parse --show-toplevel) || fail 'chunk is not a Git checkout'
TARGET=$(git -C "$3" rev-parse --show-toplevel) || fail 'target is not a Git checkout'
WT=$(cd "$WT" && pwd -P)
TARGET=$(cd "$TARGET" && pwd -P)
[[ $WT != "$TARGET" ]] || fail 'chunk and target must be different checkouts'
common_dir() {
  local COMMON
  COMMON=$(git -C "$1" rev-parse --git-common-dir) || return
  if [[ $COMMON != /* ]]; then COMMON="$1/$COMMON"; fi
  (cd "$COMMON" && pwd -P)
}
CHUNK_COMMON=$(common_dir "$WT") || fail 'cannot resolve chunk repository'
TARGET_COMMON=$(common_dir "$TARGET") || fail 'cannot resolve target repository'
[[ $CHUNK_COMMON == "$TARGET_COMMON" ]] || fail 'chunk and target must share a Git repository'
BR=$(git -C "$WT" symbolic-ref --quiet --short HEAD) || fail 'chunk must be on a branch'
TARGET_BR=$(git -C "$TARGET" symbolic-ref --quiet --short HEAD) || fail 'target must be on a branch'
[[ $BR != "$TARGET_BR" ]] || fail 'chunk and target must use different branches'
for CHECKOUT in "$WT" "$TARGET"; do
  for STATE in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer; do
    STATE_PATH=$(git -C "$CHECKOUT" rev-parse --git-path "$STATE")
    [[ $STATE_PATH = /* ]] || STATE_PATH="$CHECKOUT/$STATE_PATH"
    [[ ! -e $STATE_PATH ]] || fail "unfinished Git operation in $CHECKOUT ($STATE)"
  done
done
STATUS=$(mktemp)
trap 'rm -f "$STATUS"' EXIT
git -C "$TARGET" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none > "$STATUS"
[[ ! -s $STATUS ]] || fail 'target checkout must be clean'
BASELINE_STATE="$WT/.fdrive-workflow"
if [[ -L $BASELINE_STATE || -L $BASELINE_STATE/baseline.json || -e $BASELINE_STATE/baseline.json ]]; then
  fail 'baseline checkout must use transfer-checkout.sh; merge only accepts a HEAD baseline'
fi
command -v pnpm >/dev/null || fail 'pnpm is required'
bash "$SCRIPT_DIR/review-chunk.sh" "$WT"
MSG=$2
if [[ -n ${CO_AUTHOR:-} ]]; then
  [[ $CO_AUTHOR != *$'\n'* && $CO_AUTHOR != *$'\r'* ]] || fail 'CO_AUTHOR must be a single line'
  MSG+=$'\n\nCo-Authored-By: '
  MSG+="$CO_AUTHOR"
fi
git -C "$WT" add -A
git -C "$WT" commit -m "$MSG"
printf 'Merging %s into %s at %s\n' "$BR" "$TARGET_BR" "$TARGET"
cd "$TARGET"
if git merge --no-ff --no-edit "$BR"; then
  :
else
  git rev-parse --verify -q MERGE_HEAD >/dev/null || fail 'merge failed without a pending merge; inspect the error above'
  git diff --name-only --diff-filter=U -z > "$STATUS"
  COUNT=0
  LOCK_ONLY=1
  while IFS= read -r -d '' FILE; do
    COUNT=$((COUNT + 1))
    [[ $FILE == pnpm-lock.yaml ]] || LOCK_ONLY=0
    printf 'merge conflict: %q\n' "$FILE" >&2
  done < "$STATUS"
  [[ $COUNT -eq 1 && $LOCK_ONLY -eq 1 ]] || fail 'merge needs manual resolution; no files were auto-resolved'
  printf 'Regenerating the sole conflict: pnpm-lock.yaml\n'
  git checkout --theirs -- pnpm-lock.yaml
  pnpm install --lockfile-only
  git add -- pnpm-lock.yaml
  git commit --no-edit
fi
pnpm install --frozen-lockfile
git log --oneline -3
