#!/bin/bash
# Disposable Git fixtures for baseline and uncommitted transfer regression coverage.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
TRANSFER="$SCRIPT_DIR/transfer-checkout.sh"
PYTHON_TRANSFER="$SCRIPT_DIR/transfer-checkout.py"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fdrive-transfer-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='Transfer Test' GIT_AUTHOR_EMAIL='transfer@example.invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
N=0
PASSES=0

fail() { printf 'FAIL %s\n' "$*" >&2; [[ ! -s $TEST_ROOT/output ]] || cat "$TEST_ROOT/output" >&2; exit 1; }
pass() { PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$1"; }
expect_success() { "$@" > "$TEST_ROOT/output" 2>&1 || fail "unexpected failure: $*"; }
expect_failure() { if "$@" > "$TEST_ROOT/output" 2>&1; then fail "unexpected success: $*"; fi; }
assert_eq() { [[ $1 == "$2" ]] || fail "expected [$2], got [$1]"; }
assert_file() { [[ -f $1 ]] || fail "missing file: $1"; }
assert_no_stage() { git -C "$1" diff --cached --quiet || fail "transfer staged files in $1"; }

node24() {
  local CANDIDATE
  CANDIDATE=$(command -v node 2>/dev/null || true)
  if [[ -n $CANDIDATE && $($CANDIDATE --version 2>/dev/null || true) == v24.* ]]; then
    printf '%s\n' "$CANDIDATE"
    return 0
  fi
  for CANDIDATE in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v24*/bin/node; do
    [[ -x $CANDIDATE ]] || continue
    printf '%s\n' "$CANDIDATE"
    return 0
  done
  return 1
}

fixture() {
  N=$((N + 1))
  ROOT="$TEST_ROOT/repository $N"
  WORKER="$TEST_ROOT/worker $N"
  TARGET="$TEST_ROOT/target $N"
  OUTSIDE="$TEST_ROOT/outside $N"
  mkdir -p "$ROOT/src" "$OUTSIDE"
  printf 'head\n' > "$ROOT/src/base.txt"
  printf 'delete\n' > "$ROOT/src/delete.txt"
  printf 'remove\n' > "$ROOT/src/remove.txt"
  printf 'ignored\n' > "$ROOT/ignored.txt"
  printf 'ignored.txt\n.fdrive-workflow/\n' > "$ROOT/.gitignore"
  git init -q -b main "$ROOT"
  git -C "$ROOT" config commit.gpgsign false
  git -C "$ROOT" add -A
  git -C "$ROOT" commit -qm base
  git -C "$ROOT" worktree add -q -b worker "$WORKER"
  git -C "$ROOT" worktree add -q -b target "$TARGET"
  printf 'baseline\n' > "$ROOT/src/base.txt"
  rm "$ROOT/src/delete.txt"
  printf 'prerequisite\n' > "$ROOT/src/prereq file.txt"
  printf '\0baseline binary\n' > "$ROOT/src/baseline binary"
  printf 'ignored source\n' > "$ROOT/ignored.txt"
  ln -s 'base.txt' "$ROOT/src/baseline link"
  expect_success python3 "$PYTHON_TRANSFER" baseline "$ROOT" "$WORKER"
  printf 'baseline\n' > "$TARGET/src/base.txt"
  rm "$TARGET/src/delete.txt"
  printf 'prerequisite\n' > "$TARGET/src/prereq file.txt"
  printf '\0baseline binary\n' > "$TARGET/src/baseline binary"
  ln -s 'base.txt' "$TARGET/src/baseline link"
  assert_eq "baseline" "$(cat "$WORKER/src/base.txt")"
  assert_no_stage "$WORKER"
}

fixture
printf 'worker change\n' > "$WORKER/src/base.txt"
rm "$WORKER/src/remove.txt"
printf 'new contents\n' > "$WORKER/src/new file.txt"
printf '\0worker binary\n' > "$WORKER/src/worker binary"
NEWLINE_NAME=$'line\nbreak.txt'
printf 'newline filename\n' > "$WORKER/src/$NEWLINE_NAME"
printf '#!/bin/sh\necho worker\n' > "$WORKER/src/run.sh"
chmod 755 "$WORKER/src/run.sh"
rm "$WORKER/src/baseline link"
ln -s 'new file.txt' "$WORKER/src/baseline link"
printf 'restored\n' > "$WORKER/src/delete.txt"
printf 'target unrelated\n' > "$TARGET/src/unrelated.txt"
expect_success env ALLOWED='src/' bash "$TRANSFER" --check "$WORKER" "$TARGET"
expect_success env ALLOWED='src/' bash "$TRANSFER" --diff "$WORKER"
grep -F 'new contents' "$TEST_ROOT/output" >/dev/null || fail 'diff omits new file contents'
grep -F 'Binary files differ: src/worker binary' "$TEST_ROOT/output" >/dev/null || fail 'diff omits binary change'
grep -F 'path src/run.sh: absent -> file mode=0755' "$TEST_ROOT/output" >/dev/null || fail 'diff omits metadata-only header'
if grep -F 'prerequisite' "$TEST_ROOT/output" >/dev/null; then fail 'diff includes unchanged baseline prerequisite'; fi
expect_success env ALLOWED='src/' bash "$TRANSFER" "$WORKER" "$TARGET"
assert_eq 'worker change' "$(cat "$TARGET/src/base.txt")"
assert_eq 'target unrelated' "$(cat "$TARGET/src/unrelated.txt")"
assert_eq 'restored' "$(cat "$TARGET/src/delete.txt")"
assert_file "$TARGET/src/new file.txt"
cmp "$WORKER/src/worker binary" "$TARGET/src/worker binary" || fail 'binary content was not preserved'
assert_eq 'newline filename' "$(cat "$TARGET/src/$NEWLINE_NAME")"
[[ -x $TARGET/src/run.sh ]] || fail 'executable mode was not preserved'
assert_eq 'new file.txt' "$(readlink "$TARGET/src/baseline link")"
assert_file "$TARGET/src/prereq file.txt"
[[ ! -e $TARGET/src/remove.txt ]] || fail 'worker deletion was not transferred'
assert_no_stage "$TARGET"
expect_success env ALLOWED='src/' bash "$TRANSFER" "$WORKER" "$TARGET"
pass 'baseline excludes prerequisites, transfers files, deletions, modes, symlinks, and is idempotent'

fixture
printf 'worker conflict candidate\n' > "$WORKER/src/base.txt"
printf 'target conflict\n' > "$TARGET/src/base.txt"
printf 'preserve all\n' > "$TARGET/src/other.txt"
expect_failure env ALLOWED='src/' bash "$TRANSFER" "$WORKER" "$TARGET"
assert_eq 'target conflict' "$(cat "$TARGET/src/base.txt")"
assert_eq 'preserve all' "$(cat "$TARGET/src/other.txt")"
assert_no_stage "$TARGET"
pass 'conflicting target preflight preserves every target edit'

fixture
printf 'worker symlink guard\n' > "$WORKER/src/base.txt"
rm -rf "$TARGET/src"
ln -s "$OUTSIDE" "$TARGET/src"
printf 'outside original\n' > "$OUTSIDE/base.txt"
expect_failure env ALLOWED='src/' bash "$TRANSFER" "$WORKER" "$TARGET"
assert_eq 'outside original' "$(cat "$OUTSIDE/base.txt")"
pass 'symlink ancestor is rejected before writes'

fixture
printf 'worker state tamper\n' > "$WORKER/src/base.txt"
printf '{"version":1,"head":"bad","entries":{}}\n' > "$WORKER/.fdrive-workflow/baseline.json"
expect_failure env ALLOWED='src/' bash "$TRANSFER" "$WORKER" "$TARGET"
assert_eq 'baseline' "$(cat "$TARGET/src/base.txt")"
pass 'tampered baseline state is rejected'

fixture
printf 'target dirty\n' > "$TARGET/src/base.txt"
expect_failure python3 "$PYTHON_TRANSFER" baseline "$ROOT" "$TARGET"
assert_eq 'target dirty' "$(cat "$TARGET/src/base.txt")"
pass 'baseline refuses a non-pristine destination before copying'

fixture
printf 'private\n' > "$ROOT/.env.local"
git -C "$ROOT" add -f .env.local
PRIVATE_TARGET="$TEST_ROOT/private target $N"
git -C "$ROOT" worktree add -q -b "private-target-$N" "$PRIVATE_TARGET"
expect_failure python3 "$PYTHON_TRANSFER" baseline "$ROOT" "$PRIVATE_TARGET"
[[ ! -e $PRIVATE_TARGET/.fdrive-workflow/baseline.json ]] || fail 'private baseline wrote a manifest'
pass 'baseline refuses a tracked private environment path'

fixture
printf 'forbidden\n' > "$WORKER/outside.txt"
expect_failure env ALLOWED='src/' bash "$TRANSFER" --check "$WORKER" "$TARGET"
pass 'transfer enforces ALLOWED scope before writes'

fixture
mkdir -p "$WORKER/.fdrive-workflow/command.lock"
: > "$WORKER/.fdrive-workflow/command.lock/owner"
set +e
env ALLOWED='src/' bash "$TRANSFER" --check "$WORKER" "$TARGET" > "$TEST_ROOT/output" 2>&1
LOCK_STATUS=$?
set -e
[[ $LOCK_STATUS -eq 75 ]] || fail "lock contention exit was $LOCK_STATUS, expected 75"
[[ ! -e $TARGET/.fdrive-workflow/command.lock ]] || fail 'partial lock was not released after contention'
pass 'lock contention is fail-fast and empty owner is safe'

fixture
printf 'worker atomic\n' > "$WORKER/src/base.txt"
printf 'unrelated temporary\n' > "$TARGET/src/base.txt.fdrive-transfer-tmp"
expect_success env ALLOWED='src/' bash "$TRANSFER" "$WORKER" "$TARGET"
assert_eq 'unrelated temporary' "$(cat "$TARGET/src/base.txt.fdrive-transfer-tmp")"
pass 'transfer never removes a fixed-name temporary collision'

LARGE_ROOT="$TEST_ROOT/large repository"
LARGE_WORKER="$TEST_ROOT/large worker"
LARGE_TARGET="$TEST_ROOT/large target"
mkdir -p "$LARGE_ROOT/src"
for INDEX in $(seq 1 1100); do printf '%s\n' "$INDEX" > "$LARGE_ROOT/src/$INDEX.txt"; done
git init -q -b main "$LARGE_ROOT"
git -C "$LARGE_ROOT" add -A
git -C "$LARGE_ROOT" commit -qm large
git -C "$LARGE_ROOT" worktree add -q -b large-worker "$LARGE_WORKER"
git -C "$LARGE_ROOT" worktree add -q -b large-target "$LARGE_TARGET"
printf 'changed\n' > "$LARGE_WORKER/src/1100.txt"
expect_success env ALLOWED='src/' bash "$TRANSFER" "$LARGE_WORKER" "$LARGE_TARGET"
assert_eq 'changed' "$(cat "$LARGE_TARGET/src/1100.txt")"
pass 'large HEAD snapshots stream Git blobs without a pipe deadlock'

PREP_ROOT="$TEST_ROOT/prepare source"
PREP_DEST="$TEST_ROOT/prepare destination"
PREP_FAILURE_DEST="$TEST_ROOT/prepare failure"
PREP_BUNDLE="$TEST_ROOT/prepare helpers"
PREP_MARKER="$TEST_ROOT/setup marker"
PREP_OUT="$TEST_ROOT/prepare stdout"
PREP_ERR="$TEST_ROOT/prepare stderr"
PREP_NODE=$(node24) || fail 'Node 24 is required for prepare fixture'
mkdir -p "$PREP_ROOT/src" "$PREP_BUNDLE"
printf '{"packageManager":"pnpm@10.11.0"}\n' > "$PREP_ROOT/package.json"
printf 'head\n' > "$PREP_ROOT/src/base.txt"
git init -q -b main "$PREP_ROOT"
git -C "$PREP_ROOT" add -A
git -C "$PREP_ROOT" commit -qm prepare
printf 'prerequisite\n' > "$PREP_ROOT/src/prereq.txt"
cp "$SCRIPT_DIR/command-lib.sh" "$SCRIPT_DIR/prepare-worktree.sh" "$SCRIPT_DIR/transfer-checkout.py" "$PREP_BUNDLE"
printf '%s\n' '#!/bin/bash' 'if [[ ${1:-} == --version ]]; then printf "10.11.0\\n"; exit 0; fi' 'exit 1' > "$PREP_BUNDLE/pnpm"
printf '%s\n' '#!/bin/bash' 'set -euo pipefail' 'ROOT=$1' 'grep -Fx "prerequisite" "$ROOT/src/prereq.txt" >/dev/null' '[[ -f $ROOT/.fdrive-workflow/baseline.json ]]' 'printf "setup saw baseline\\n" > "$BASELINE_MARKER"' > "$PREP_BUNDLE/setup-checkout.sh"
chmod +x "$PREP_BUNDLE/pnpm" "$PREP_BUNDLE/setup-checkout.sh"
env FDRIVE_NODE="$PREP_NODE" FDRIVE_PNPM="$PREP_BUNDLE/pnpm" BASELINE_MARKER="$PREP_MARKER" \
  bash "$PREP_BUNDLE/prepare-worktree.sh" "$PREP_ROOT" prepare-working "$PREP_DEST" --working-tree > "$PREP_OUT" 2> "$PREP_ERR"
assert_eq "$(cd "$PREP_DEST" && pwd -P)" "$(cat "$PREP_OUT")"
assert_eq 'setup saw baseline' "$(cat "$PREP_MARKER")"
assert_eq 'prerequisite' "$(cat "$PREP_DEST/src/prereq.txt")"
printf 'private\n' > "$PREP_ROOT/.env.local"
git -C "$PREP_ROOT" add -f .env.local
rm -f "$PREP_MARKER"
set +e
env FDRIVE_NODE="$PREP_NODE" FDRIVE_PNPM="$PREP_BUNDLE/pnpm" BASELINE_MARKER="$PREP_MARKER" \
  bash "$PREP_BUNDLE/prepare-worktree.sh" "$PREP_ROOT" prepare-failure "$PREP_FAILURE_DEST" --working-tree > "$PREP_OUT" 2> "$PREP_ERR"
PREP_STATUS=$?
set -e
[[ $PREP_STATUS -ne 0 ]] || fail 'baseline failure unexpectedly succeeded'
[[ ! -s $PREP_OUT ]] || fail 'baseline failure wrote checkout to stdout'
[[ -e $PREP_FAILURE_DEST/.git ]] || fail 'baseline failure did not retain checkout'
[[ ! -e $PREP_MARKER ]] || fail 'setup ran after baseline failure'
pass 'prepare copies baseline before setup and propagates baseline failure without stdout'

printf '%s transfer regression groups passed.\n' "$PASSES"
