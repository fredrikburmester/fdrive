#!/bin/bash
# Standalone regression tests; uses disposable Git fixtures and fake pnpm, no installation.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REVIEW="$SCRIPT_DIR/review-chunk.sh"
MERGE="$SCRIPT_DIR/merge-chunk.sh"
TEST_ROOT=$(mktemp -d /private/tmp/fdrive-workflow-test.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='Workflow Test' GIT_AUTHOR_EMAIL='workflow@example.invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_MERGE_AUTOEDIT=no GIT_EDITOR=true
mkdir "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/pnpm" <<'PNPM'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$PNPM_LOG"
if [[ ${FAIL_PNPM:-} == "$*" ]]; then exit 23; fi
if [[ $* == 'install --lockfile-only' ]]; then printf 'regenerated\n' > pnpm-lock.yaml; fi
PNPM
chmod +x "$TEST_ROOT/bin/pnpm"
export PATH="$TEST_ROOT/bin:$PATH" PNPM_LOG="$TEST_ROOT/pnpm.log"
N=0
PASSES=0
fixture() {
  N=$((N + 1))
  TARGET="$TEST_ROOT/repo $N"
  CHUNK="$TEST_ROOT/chunk $N"
  git init -q -b integration "$TARGET"
  git -C "$TARGET" config commit.gpgsign false
  git -C "$TARGET" config merge.gpgsign false
  git -C "$TARGET" config core.hooksPath "$TARGET/.git/hooks"
  mkdir -p "$TARGET/src" "$TARGET/outside"
  printf 'base\n' > "$TARGET/src/file name.txt"
  printf 'base\n' > "$TARGET/outside/original name.txt"
  printf 'base lock\n' > "$TARGET/pnpm-lock.yaml"
  git -C "$TARGET" add -A
  git -C "$TARGET" commit -qm base
  git -C "$TARGET" worktree add -q -b chunk "$CHUNK"
  : > "$PNPM_LOG"
  unset FAIL_PNPM CO_AUTHOR ALLOWED
}
pass() { PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$*" >&2; cat "$TEST_ROOT/output" >&2; exit 1; }
expect_failure() {
  if "$@" > "$TEST_ROOT/output" 2>&1; then fail "unexpected success: $*"; fi
}
expect_success() {
  if ! "$@" > "$TEST_ROOT/output" 2>&1; then fail "unexpected failure: $*"; fi
}
assert_clean() { [[ -z $(git -C "$1" status --porcelain) ]] || fail "dirty fixture: $1"; }

fixture
expect_failure bash "$REVIEW"
expect_failure bash "$REVIEW" "$CHUNK"
expect_failure env ALLOWED='[' bash "$REVIEW" "$CHUNK"
expect_success env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
pass 'review usage, required scope, invalid regex, clean checkout'

printf 'staged\n' > "$CHUNK/src/staged name.txt"
git -C "$CHUNK" add -A
printf 'unstaged\n' > "$CHUNK/src/file name.txt"
printf 'untracked\n' > "$CHUNK/src/untracked name.txt"
printf 'lock\n' > "$CHUNK/pnpm-lock.yaml"
expect_success env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
printf 'forbidden\n' > "$CHUNK/outside/untracked name.txt"
expect_failure env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
rm "$CHUNK/outside/untracked name.txt"
printf 'forbidden\n' > "$CHUNK/outside/original name.txt"
expect_failure env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
git -C "$CHUNK" add outside
expect_failure env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
pass 'staged, unstaged, untracked, spaces, exact root lockfile allowance'

fixture
printf 'forbidden\n' > "$CHUNK/pnpm-lock.yaml.backup"
expect_failure env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
rm "$CHUNK/pnpm-lock.yaml.backup"
printf 'forbidden\n' > "$CHUNK/outside/pnpm-lock.yaml"
expect_failure env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
pass 'lockfile prefix and nested lockfiles rejected'

fixture
git -C "$CHUNK" mv 'outside/original name.txt' 'src/renamed name.txt'
expect_failure env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
expect_success env ALLOWED='src/|outside/' bash "$REVIEW" "$CHUNK"
pass 'rename source checked, paths with spaces allowed'
fixture
git -C "$CHUNK" mv 'src/file name.txt' 'outside/destination name.txt'
expect_failure env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
pass 'rename destination checked'

fixture
printf 'stash\n' > "$CHUNK/src/file name.txt"
git -C "$CHUNK" stash push -qm fixture
expect_failure env ALLOWED='src/' bash "$REVIEW" "$CHUNK"
pass 'repository stash rejected even with clean checkout'

fixture
printf 'chunk\n' > "$CHUNK/src/file name.txt"
BEFORE=$(git -C "$CHUNK" rev-parse HEAD)
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk'
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk' "$CHUNK"
printf 'dirty\n' > "$TARGET/dirty target.txt"
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk' "$TARGET"
rm "$TARGET/dirty target.txt"
printf 'outside\n' > "$CHUNK/outside/forbidden.txt"
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk' "$TARGET"
[[ $(git -C "$CHUNK" rev-parse HEAD) == "$BEFORE" ]] || fail 'rejected merge committed changes'
git -C "$CHUNK" diff --cached --quiet || fail 'rejected merge staged changes'
pass 'missing/same/dirty target and failed review rejected before staging'

fixture
printf 'chunk\n' > "$CHUNK/src/file name.txt"
FOREIGN="$TEST_ROOT/foreign"
git init -q -b foreign "$FOREIGN"
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk' "$FOREIGN"
git -C "$CHUNK" checkout -q --detach
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk' "$TARGET"
pass 'foreign repository and detached chunk rejected'

fixture
printf 'chunk\n' > "$CHUNK/src/file name.txt"
expect_success env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk' "$TARGET"
[[ $(git -C "$CHUNK" rev-list --count HEAD) == 2 ]] || fail 'expected exactly one chunk commit'
[[ $(git -C "$TARGET" rev-list --count HEAD) == 3 ]] || fail 'expected merge commit'
[[ $(git -C "$TARGET" show -s --format=%P | wc -w | tr -d ' ') == 2 ]] || fail 'merge must have two parents'
[[ $(git -C "$CHUNK" show -s --format=%B) == 'feat: chunk' ]] || fail 'unexpected attribution'
[[ $(cat "$PNPM_LOG") == 'install --frozen-lockfile' ]] || fail 'expected frozen install'
assert_clean "$TARGET"
pass 'arbitrary target branch, one chunk commit, no-ff merge, no default attribution'

fixture
printf 'chunk\n' > "$CHUNK/src/file name.txt"
expect_success env ALLOWED='src/' CO_AUTHOR='Explicit User <explicit@example.invalid>' bash "$MERGE" "$CHUNK" 'feat: chunk' "$TARGET"
[[ $(git -C "$CHUNK" show -s --format=%B) == *'Co-Authored-By: Explicit User <explicit@example.invalid>'* ]] || fail 'missing explicit attribution'
pass 'optional explicit co-author'

fixture
printf '#!/bin/sh\nexit 42\n' > "$TARGET/.git/hooks/pre-commit"
chmod +x "$TARGET/.git/hooks/pre-commit"
printf 'chunk\n' > "$CHUNK/src/file name.txt"
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk' "$TARGET"
[[ $(git -C "$CHUNK" rev-list --count HEAD) == 1 ]] || fail 'commit bypassed hook'
pass 'commit hooks remain enabled'

fixture
printf 'chunk\n' > "$CHUNK/src/file name.txt"
expect_failure env ALLOWED='src/' FAIL_PNPM='install --frozen-lockfile' bash "$MERGE" "$CHUNK" 'feat: chunk' "$TARGET"
[[ $(cat "$PNPM_LOG") == 'install --frozen-lockfile' ]] || fail 'failed frozen install triggered fallback'
pass 'dependency failure propagated without mutable fallback'

lock_conflict() {
  printf 'target lock\n' > "$TARGET/pnpm-lock.yaml"
  git -C "$TARGET" add pnpm-lock.yaml
  git -C "$TARGET" commit -qm 'target lock'
  printf 'chunk lock\n' > "$CHUNK/pnpm-lock.yaml"
}
fixture
lock_conflict
expect_success env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: lock' "$TARGET"
[[ $(cat "$TARGET/pnpm-lock.yaml") == regenerated ]] || fail 'lockfile not regenerated'
[[ $(cat "$PNPM_LOG") == $'install --lockfile-only\ninstall --frozen-lockfile' ]] || fail 'unexpected install calls'
assert_clean "$TARGET"
pass 'sole lockfile conflict regenerated and frozen install verified'

fixture
lock_conflict
expect_failure env ALLOWED='src/' FAIL_PNPM='install --lockfile-only' bash "$MERGE" "$CHUNK" 'feat: lock' "$TARGET"
git -C "$TARGET" rev-parse --verify -q MERGE_HEAD >/dev/null || fail 'failed regeneration completed merge'
[[ $(git -C "$TARGET" diff --name-only --diff-filter=U) == pnpm-lock.yaml ]] || fail 'failed regeneration staged lock'
pass 'lockfile regeneration failure leaves pending unresolved merge'

fixture
lock_conflict
printf 'target code\n' > "$TARGET/src/file name.txt"
git -C "$TARGET" add src
git -C "$TARGET" commit -qm 'target code'
printf 'chunk code\n' > "$CHUNK/src/file name.txt"
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: conflicting chunk' "$TARGET"
[[ $(git -C "$TARGET" diff --name-only --diff-filter=U | wc -l | tr -d ' ') == 2 ]] || fail 'mixed conflicts auto-resolved'
[[ ! -s $PNPM_LOG ]] || fail 'mixed conflicts ran pnpm'
expect_failure env ALLOWED='src/' bash "$REVIEW" "$TARGET"
pass 'mixed conflicts preserved and review rejects unresolved conflicts'

fixture
printf '#!/bin/sh\nexit 42\n' > "$TARGET/.git/hooks/pre-merge-commit"
chmod +x "$TARGET/.git/hooks/pre-merge-commit"
printf 'chunk\n' > "$CHUNK/src/file name.txt"
expect_failure env ALLOWED='src/' bash "$MERGE" "$CHUNK" 'feat: chunk' "$TARGET"
[[ ! -s $PNPM_LOG ]] || fail 'non-conflict merge failure treated as lockfile conflict'
git -C "$TARGET" rev-parse --verify -q MERGE_HEAD >/dev/null || fail 'merge hook failure was bypassed'
pass 'non-conflict merge errors propagated and merge hooks honored'

printf '%s workflow regression groups passed.\n' "$PASSES"
