#!/bin/bash
# usage: ALLOWED="<allowed path-prefix regex>" review-chunk.sh <worktree-dir>
# Checks staged, unstaged, and untracked paths, both rename paths, conflicts, and stash.
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
WT=$(git -C "$1" rev-parse --show-toplevel) || fail 'worktree is not a Git checkout'
STATUS=$(mktemp)
trap 'rm -f "$STATUS"' EXIT
git -C "$WT" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none > "$STATUS"
STASH=$(git -C "$WT" stash list)
FAILED=0
check_path() {
  if [[ $1 != pnpm-lock.yaml && ! $1 =~ $SCOPE ]]; then
    printf 'out of scope: %q\n' "$1" >&2
    FAILED=1
  fi
}
printf 'Reviewing %s (%s)\n' "$WT" "$(git -C "$WT" branch --show-current)"
while IFS= read -r -d '' ENTRY; do
  CODE=${ENTRY:0:2}
  FILE=${ENTRY:3}
  printf '%s %q\n' "$CODE" "$FILE"
  check_path "$FILE"
  case "$CODE" in
    DD|AU|UD|UA|DU|AA|UU)
      printf 'unresolved conflict: %q\n' "$FILE" >&2
      FAILED=1
      ;;
  esac
  case "$CODE" in
    *R*|*C*)
      IFS= read -r -d '' ORIGINAL <&0 || fail 'incomplete rename/copy status'
      printf '   from %q\n' "$ORIGINAL"
      check_path "$ORIGINAL"
      ;;
  esac
done < "$STATUS"
if [[ -n $STASH ]]; then
  printf 'review-chunk: repository stash must be empty\n' >&2
  FAILED=1
fi
[[ $FAILED -eq 0 ]] || exit 1
printf 'Review passed: scope, conflicts, stash.\n'
