#!/bin/bash
# Standalone regression tests for command helpers. All Git mutations use disposable fixtures.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
HELPERS_DIR=${FDRIVE_HELPERS_DIR:-$SCRIPT_DIR}
RUN="$HELPERS_DIR/run-in-checkout.sh"
SETUP="$HELPERS_DIR/setup-checkout.sh"
PREPARE="$HELPERS_DIR/prepare-worktree.sh"
VERIFY="$HELPERS_DIR/verify.sh"

for HELPER in "$RUN" "$SETUP" "$PREPARE" "$VERIFY"; do
  [[ -f $HELPER ]] || { printf 'missing helper: %s\n' "$HELPER" >&2; exit 1; }
done

TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fdrive-command-helper-test.XXXXXX")
TEST_ROOT=$(cd "$TEST_ROOT" && pwd -P)
OUT="$TEST_ROOT/stdout"
ERR="$TEST_ROOT/stderr"
BACKGROUND_PIDS=''
cleanup() {
  for PID in $BACKGROUND_PIDS; do
    kill "$PID" 2>/dev/null || true
  done
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='Command Helper Test' GIT_AUTHOR_EMAIL='helper@example.invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_MERGE_AUTOEDIT=no GIT_EDITOR=true

find_node24() {
  local CANDIDATE VERSION
  CANDIDATE=$(command -v node 2>/dev/null || true)
  if [[ -n $CANDIDATE ]]; then
    VERSION=$("$CANDIDATE" --version 2>/dev/null || true)
    case "$VERSION" in v24.*) printf '%s\n' "$CANDIDATE"; return 0;; esac
  fi
  for CANDIDATE in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v24*/bin/node; do
    [[ -x $CANDIDATE ]] || continue
    printf '%s\n' "$CANDIDATE"
    return 0
  done
  return 1
}

NODE24=$(find_node24) || { printf 'Node 24 fixture runtime unavailable\n' >&2; exit 1; }
REAL_NODE24=$NODE24
export REAL_NODE24
RUNTIME_DIR="$TEST_ROOT/runtime with spaces"
mkdir -p "$RUNTIME_DIR"
PNPM_LOG="$TEST_ROOT/pnpm.log"
PNPM_COMMAND_LOG="$TEST_ROOT/pnpm-command.log"
TOOL_LOG="$TEST_ROOT/tool.log"
FAKE_STORE_PATH="$TEST_ROOT/fake pnpm store"
export PNPM_LOG PNPM_COMMAND_LOG TOOL_LOG FAKE_STORE_PATH
unset CI

FAKE_PNPM="$RUNTIME_DIR/pnpm fake"
cat > "$FAKE_PNPM" <<'PNPM'
#!/bin/bash
set -euo pipefail
if [[ ${1:-} == --version && $# -eq 1 ]]; then
  if [[ -n ${REQUIRE_NODE24_PROBE:-} ]]; then
    case "$(node --version 2>/dev/null || true)" in
      v24.*) ;;
      *) exit 82 ;;
    esac
    printf 'PROBE_NODE=<%s>\n' "$(command -v node)" >> "$PNPM_LOG"
  fi
  printf '%s\n' "${FAKE_PNPM_VERSION:-10.11.0}"
  exit 0
fi
{
  printf 'CALL'
  for ARG in "$@"; do printf ' <%s>' "$ARG"; done
  printf ' PWD=<%s> NODE=<%s> PNPM=<%s> PORTS=<%s,%s> CI=<%s>\n' \
    "$PWD" "$(command -v node)" "$(command -v pnpm)" \
    "${E2E_API_PORT:-}" "${E2E_WEB_PORT:-}" "${CI:-}"
} >> "$PNPM_LOG"
JOINED=$*
printf '%s\n' "$JOINED" >> "$PNPM_COMMAND_LOG"
if [[ $JOINED == 'store path' ]]; then
  printf '%s\n' "$FAKE_STORE_PATH"
  exit 0
fi
if [[ -n ${FAKE_PNPM_BLOCK:-} && $JOINED == "$FAKE_PNPM_BLOCK" ]]; then
  SIGNALLED=0
  trap 'SIGNALLED=1; : > "$BLOCK_SEEN"' INT TERM
  printf '%s\n' "$$" > "$BLOCK_PID_FILE"
  : > "$BLOCK_READY"
  while [[ ! -e $BLOCK_RELEASE ]]; do :; done
  if [[ $SIGNALLED -eq 1 ]]; then exit "${BLOCK_EXIT_CODE:-53}"; fi
fi
if [[ -n ${FAKE_PNPM_OUTPUT:-} && $JOINED == "$FAKE_PNPM_OUTPUT" ]]; then
  printf 'fake stdout %s\n' "$FAKE_PNPM_OUTPUT"
  if [[ -z ${FAKE_PNPM_NO_STDERR:-} ]]; then
    printf 'fake stderr %s\n' "$FAKE_PNPM_OUTPUT" >&2
  fi
fi
if [[ -n ${FAKE_PNPM_OUTPUT_BYTES:-} && $JOINED == "${FAKE_PNPM_OUTPUT_COMMAND:-}" ]]; then
  PADDING=$(printf "%${FAKE_PNPM_OUTPUT_BYTES}s" '')
  printf 'BEGIN-%s-END\n' "${PADDING// /x}"
fi
if [[ -n ${FAKE_PNPM_FAIL:-} && $JOINED == "$FAKE_PNPM_FAIL" ]]; then
  exit "${FAKE_PNPM_FAIL_CODE:-23}"
fi
if [[ $JOINED == '--filter @fdrive/db... run build' && -z ${FAKE_SKIP_BUILD:-} ]]; then
  mkdir -p packages/db/dist/bin
  cat > packages/db/dist/bin/migrate.js <<'MIGRATE'
#!/usr/bin/env node
require('fs').writeFileSync(process.env.MIGRATION_MARKER, 'executed\n');
MIGRATE
  chmod +x packages/db/dist/bin/migrate.js
fi
if [[ $JOINED == 'install --frozen-lockfile' && -f packages/db/dist/bin/migrate.js && -z ${FAKE_SKIP_SHIM:-} ]]; then
  mkdir -p apps/api/node_modules/.bin
  ln -sf "$(pwd -P)/packages/db/dist/bin/migrate.js" apps/api/node_modules/.bin/fdrive-migrate
fi
PNPM
chmod +x "$FAKE_PNPM"

FAKE_PNPM_CJS="$RUNTIME_DIR/pnpm fake.cjs"
cat > "$FAKE_PNPM_CJS" <<'PNPMCJS'
#!/usr/bin/env node
if (process.argv.length === 3 && process.argv[2] === "--version") {
  console.log("10.11.0");
  process.exit(0);
}
console.log(process.argv.slice(2).join("|"));
PNPMCJS
chmod +x "$FAKE_PNPM_CJS"

BAD_NODE="$RUNTIME_DIR/node 23"
cat > "$BAD_NODE" <<'NODE'
#!/bin/bash
printf 'v23.9.0\n'
NODE
chmod +x "$BAD_NODE"

TEST_BIN="$TEST_ROOT/test bin"
mkdir -p "$TEST_BIN"
cat > "$TEST_BIN/python3" <<'PYTHON'
#!/bin/bash
set -euo pipefail
if [[ ${1:-} == --version ]]; then printf 'Python 3.11.99\n'; exit 0; fi
printf 'python3' >> "$TOOL_LOG"
for ARG in "$@"; do printf ' <%s>' "$ARG" >> "$TOOL_LOG"; done
printf ' PWD=<%s>\n' "$PWD" >> "$TOOL_LOG"
PYTHON
chmod +x "$TEST_BIN/python3"

export PATH="$TEST_BIN:$PATH"
N=0
PASSES=0
ROOT=''

fail() {
  printf 'FAIL %s\n' "$*" >&2
  [[ ! -s $OUT ]] || { printf '%s\n' 'stdout:' >&2; sed -n '1,160p' "$OUT" >&2; }
  [[ ! -s $ERR ]] || { printf '%s\n' 'stderr:' >&2; sed -n '1,160p' "$ERR" >&2; }
  exit 1
}

pass() { PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$1"; }

capture() {
  : > "$OUT"
  : > "$ERR"
  set +e
  "$@" > "$OUT" 2> "$ERR"
  STATUS=$?
  set -e
}

capture_stdin() {
  local INPUT=$1
  shift
  : > "$OUT"
  : > "$ERR"
  set +e
  "$@" < "$INPUT" > "$OUT" 2> "$ERR"
  STATUS=$?
  set -e
}

expect_status() {
  local EXPECTED=$1
  shift
  capture "$@"
  [[ $STATUS -eq $EXPECTED ]] || fail "expected exit $EXPECTED, got $STATUS: $*"
}

expect_success() { expect_status 0 "$@"; }

expect_failure() {
  capture "$@"
  [[ $STATUS -ne 0 ]] || fail "unexpected success: $*"
}

assert_eq() { [[ $1 == "$2" ]] || fail "expected [$2], got [$1]"; }
assert_file() { [[ -e $1 ]] || fail "missing file: $1"; }
assert_no_file() { [[ ! -e $1 ]] || fail "unexpected file: $1"; }
assert_contains() { grep -F -- "$2" "$1" >/dev/null || fail "missing [$2] in $1"; }
assert_not_contains() { ! grep -F -- "$2" "$1" >/dev/null || fail "unexpected [$2] in $1"; }

wait_for_file() {
  local FILE=$1 STARTED=$SECONDS
  while [[ ! -f $FILE ]]; do
    [[ $((SECONDS - STARTED)) -lt 10 ]] || return 1
  done
}

write_repo_files() {
  mkdir -p "$ROOT/packages/db" "$ROOT/packages/core" "$ROOT/apps/api" \
    "$ROOT/tools/orchestration" "$ROOT/.codex/agents"
  cat > "$ROOT/package.json" <<'JSON'
{
  "name": "fixture",
  "private": true,
  "packageManager": "pnpm@10.11.0"
}
JSON
  cat > "$ROOT/packages/db/package.json" <<'JSON'
{"name":"@fdrive/db","private":true,"bin":{"fdrive-migrate":"./dist/bin/migrate.js"},"scripts":{"build":"fixture"}}
JSON
  cat > "$ROOT/packages/core/package.json" <<'JSON'
{"name":"@fdrive/core","private":true,"scripts":{"typecheck":"fixture","test:coverage":"fixture"}}
JSON
  cat > "$ROOT/.codex/config.toml" <<'TOML'
[agents]
max_threads = 3
TOML
  for NAME in command-lib run-in-checkout setup-checkout prepare-worktree verify; do
    cat > "$ROOT/tools/orchestration/$NAME.sh" <<'STUB'
#!/bin/bash
set -euo pipefail
STUB
    chmod +x "$ROOT/tools/orchestration/$NAME.sh"
  done
  for NAME in test-orchestration test-command-helpers; do
    cat > "$ROOT/tools/orchestration/$NAME.sh" <<'STUB'
#!/bin/bash
set -euo pipefail
printf '%s PWD=<%s>\n' "$(basename "$0")" "$PWD" >> "$TOOL_LOG"
STUB
    chmod +x "$ROOT/tools/orchestration/$NAME.sh"
  done
}

new_repo() {
  N=$((N + 1))
  ROOT="$TEST_ROOT/repo $N"
  mkdir -p "$ROOT"
  write_repo_files
  git init -q "$ROOT"
  git -C "$ROOT" checkout -qb fixture
  git -C "$ROOT" config commit.gpgsign false
  git -C "$ROOT" add -A
  git -C "$ROOT" commit -qm base
  : > "$PNPM_LOG"
  : > "$PNPM_COMMAND_LOG"
  : > "$TOOL_LOG"
  unset FAKE_PNPM_VERSION FAKE_PNPM_FAIL FAKE_PNPM_FAIL_CODE FAKE_PNPM_OUTPUT \
    FAKE_PNPM_NO_STDERR FAKE_PNPM_OUTPUT_BYTES FAKE_PNPM_OUTPUT_COMMAND FAKE_SKIP_BUILD FAKE_SKIP_SHIM
  export MIGRATION_MARKER="$TEST_ROOT/migration-marker-$N"
}

runtime_env() {
  env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" "$@"
}

from_outside() {
  (cd "$TEST_ROOT" && "$@")
}

lock_path() {
  printf '%s/.fdrive-workflow/command.lock\n' "$1"
}

make_tool() {
  local PATHNAME=$1
  mkdir -p "$(dirname "$PATHNAME")"
  cat > "$PATHNAME" <<'TOOL'
#!/bin/bash
set -euo pipefail
printf '%s' "$(basename "$0")" >> "$TOOL_LOG"
for ARG in "$@"; do printf ' <%s>' "$ARG" >> "$TOOL_LOG"; done
printf ' PWD=<%s>\n' "$PWD" >> "$TOOL_LOG"
TOOL
  chmod +x "$PATHNAME"
}

make_fake_node() {
  local PATHNAME=$1 VERSION=$2
  mkdir -p "$(dirname "$PATHNAME")"
  cat > "$PATHNAME" <<'NODE_WRAPPER'
#!/bin/bash
set -euo pipefail
if [[ $# -eq 1 && $1 == --version ]]; then
  SELF=$0
  while [[ -L $SELF ]]; do
    LINK_DIR=$(cd "$(dirname "$SELF")" && pwd -P)
    LINK_TARGET=$(readlink "$SELF")
    case "$LINK_TARGET" in
      /*) SELF=$LINK_TARGET ;;
      *) SELF="$LINK_DIR/$LINK_TARGET" ;;
    esac
  done
  cat "$SELF.version"
  exit 0
fi
exec "$REAL_NODE24" "$@"
NODE_WRAPPER
  printf '%s\n' "$VERSION" > "$PATHNAME.version"
  chmod +x "$PATHNAME"
}

# Help and usage validation must not select a runtime or mutate a checkout.
for HELPER in "$RUN" "$SETUP" "$PREPARE" "$VERIFY"; do
  expect_success env FDRIVE_NODE="$BAD_NODE" FDRIVE_PNPM=/missing bash "$HELPER" --help
done
expect_success bash "$VERIFY" --help
assert_contains "$OUT" 'FDRIVE_VERBOSE=1'
new_repo
HEAD_BEFORE=$(git -C "$ROOT" rev-parse HEAD)
expect_failure runtime_env bash "$RUN" "$ROOT"
expect_failure runtime_env bash "$SETUP" "$ROOT" extra
expect_failure runtime_env bash "$PREPARE" "$ROOT" 'Bad Chunk'
expect_failure runtime_env bash "$VERIFY" "$ROOT" unknown
assert_eq "$(git -C "$ROOT" rev-parse HEAD)" "$HEAD_BEFORE"
assert_eq "$(git -C "$ROOT" status --porcelain)" ''
pass 'help and invalid argument shapes are mutation-free'

# Package-manager selection parses valid JSON independently of whitespace and line layout.
printf '%s\n' '{"name":"fixture","private":true,"packageManager":"pnpm@10.11.0"}' > "$ROOT/package.json"
expect_success runtime_env bash "$RUN" "$ROOT" -- true
git -C "$ROOT" checkout -q -- package.json
pass 'compact packageManager JSON is accepted'

# The checkout must be the repository root. Symlinks normalize; arbitrary subdirectories fail.
mkdir -p "$ROOT/arbitrary"
expect_failure runtime_env bash "$RUN" "$ROOT/arbitrary" -- true
ln -s "$ROOT" "$TEST_ROOT/repository-link"
expect_success runtime_env bash "$RUN" "$TEST_ROOT/repository-link" -- pwd
assert_eq "$(cat "$OUT")" "$(cd "$ROOT" && pwd -P)"
pass 'checkout root validation and symlink normalization'

# Exact argv, environment, cwd, nested runtime shims, status, and log redaction.
INSPECT="$TEST_ROOT/inspect child.sh"
cat > "$INSPECT" <<'INSPECT'
#!/bin/bash
set -euo pipefail
printf 'cwd=<%s> keep=<%s> argc=<%s>\n' "$PWD" "${KEEP_VALUE:-}" "$#"
for ARG in "$@"; do printf 'arg=<%s>\n' "$ARG"; done
printf 'node=<%s> node_version=<%s> pnpm=<%s> pnpm_version=<%s>\n' \
  "$(command -v node)" "$(node --version)" "$(command -v pnpm)" "$(pnpm --version)"
exit "${CHILD_EXIT:-0}"
INSPECT
chmod +x "$INSPECT"
expect_success from_outside env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  KEEP_VALUE='kept value' bash "$RUN" "$ROOT" -- bash "$INSPECT" 'secret arg with spaces' '*'
assert_contains "$OUT" "cwd=<$ROOT> keep=<kept value> argc=<2>"
assert_contains "$OUT" 'arg=<secret arg with spaces>'
assert_contains "$OUT" 'arg=<*>'
assert_contains "$OUT" 'node_version=<v24.'
assert_contains "$OUT" 'pnpm_version=<10.11.0>'
assert_not_contains "$ERR" 'secret arg with spaces'
expect_status 37 from_outside env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  CHILD_EXIT=37 bash "$RUN" "$ROOT" -- bash "$INSPECT"
assert_contains "$ERR" '37'
pass 'run wrapper preserves cwd, argv, environment, runtime, redaction, and exit status'

# Locked custom commands use the compact step contract; unlocked commands keep direct stdout.
new_repo
expect_success runtime_env bash "$RUN" "$ROOT" --lock -- bash -c 'printf "locked command output\\n"'
assert_eq "$(cat "$OUT")" ''
assert_contains "$ERR" 'run-in-checkout: PASS command'
LOCKED_LOG_OUT=$(find "$ROOT/.fdrive-workflow/logs" -name stdout.log -type f -print | tail -n 1)
LOCKED_LOG_LABEL=$(dirname "$LOCKED_LOG_OUT")/label.txt
assert_contains "$LOCKED_LOG_OUT" 'locked command output'
assert_eq "$(cat "$LOCKED_LOG_LABEL")" 'command'
expect_success env FDRIVE_VERBOSE=1 FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  bash "$RUN" "$ROOT" --lock -- bash -c 'printf "locked command output\\n"'
assert_contains "$OUT" 'locked command output'
pass 'locked commands are compact by default with labeled retained logs and verbose replay'

# Named verification steps are quiet by default, retain both streams, and replay them when requested.
new_repo
expect_success env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_PNPM_OUTPUT='test:integration' \
  bash "$VERIFY" "$ROOT" integration
assert_eq "$(cat "$OUT")" ''
assert_not_contains "$ERR" 'fake stdout test:integration'
assert_contains "$ERR" 'verify: PASS integration tests'
QUIET_LOG_OUT=$(find "$ROOT/.fdrive-workflow/logs" -name stdout.log -type f -print | tail -n 1)
QUIET_LOG_ERR=$(find "$ROOT/.fdrive-workflow/logs" -name stderr.log -type f -print | tail -n 1)
assert_file "$QUIET_LOG_OUT"
assert_file "$QUIET_LOG_ERR"
assert_contains "$QUIET_LOG_OUT" 'fake stdout test:integration'
assert_contains "$QUIET_LOG_ERR" 'fake stderr test:integration'
expect_success env FDRIVE_VERBOSE=1 FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_PNPM_NO_STDERR=1 \
  FAKE_PNPM_OUTPUT='test:integration' bash "$VERIFY" "$ROOT" integration
assert_contains "$OUT" 'fake stdout test:integration'
assert_not_contains "$ERR" 'fake stderr test:integration'
pass 'verification defaults to compact statuses, keeps logs, and supports verbose replay'

expect_status 54 env FDRIVE_VERBOSE=1 FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  FAKE_PNPM_OUTPUT='test:integration' FAKE_PNPM_FAIL='test:integration' FAKE_PNPM_FAIL_CODE=54 \
  bash "$VERIFY" "$ROOT" integration
assert_contains "$OUT" 'fake stdout test:integration'
assert_contains "$ERR" 'verify: FAIL integration tests (exit 54); logs:'
pass 'verbose verification preserves failed child exit status'

# Failure output has the child's first status, log locations, and bounded excerpts.
new_repo
expect_status 52 env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  FAKE_PNPM_OUTPUT_BYTES=5000 FAKE_PNPM_OUTPUT_COMMAND='test:integration' \
  FAKE_PNPM_FAIL='test:integration' FAKE_PNPM_FAIL_CODE=52 bash "$VERIFY" "$ROOT" integration
assert_contains "$ERR" 'verify: FAIL integration tests (exit 52); logs:'
assert_contains "$ERR" 'stdout excerpt (last 4096 bytes)'
assert_contains "$ERR" 'END'
assert_not_contains "$ERR" 'BEGIN-'
[[ $(wc -c < "$ERR") -lt 6000 ]] || fail 'failure excerpt was not bounded'
FAIL_LOG_OUT=$(find "$ROOT/.fdrive-workflow/logs" -name stdout.log -type f -print | tail -n 1)
assert_contains "$FAIL_LOG_OUT" 'BEGIN-'
pass 'verification failures retain complete logs with bounded excerpts and exact status'

# Background execution preserves the wrapper's original standard input.
STDIN_FILE="$TEST_ROOT/command stdin"
printf 'stdin value with spaces\n' > "$STDIN_FILE"
capture_stdin "$STDIN_FILE" runtime_env bash "$RUN" "$ROOT" -- bash -c \
  'IFS= read -r value; printf "stdin=<%s>\n" "$value"'
[[ $STATUS -eq 0 ]] || fail "stdin command failed with $STATUS"
assert_eq "$(cat "$OUT")" 'stdin=<stdin value with spaces>'
pass 'run wrapper preserves child standard input'

# Runtime shims are scoped to one invocation and removed afterward.
SCOPED_TMP="$TEST_ROOT/scoped runtime temp"
mkdir -p "$SCOPED_TMP"
expect_success env TMPDIR="$SCOPED_TMP" FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  bash "$RUN" "$ROOT" -- true
[[ -z $(find "$SCOPED_TMP" -mindepth 1 -maxdepth 1 -name 'fdrive-runtime.*' -print -quit) ]] || \
  fail 'runtime shim directory leaked after command'
pass 'runtime shim directory is cleaned after command'

# A .cjs manager entrypoint is run with the selected Node runtime.
expect_success runtime_env env FDRIVE_PNPM="$FAKE_PNPM_CJS" bash "$RUN" "$ROOT" -- pnpm --version
assert_eq "$(cat "$OUT")" '10.11.0'
pass 'pnpm cjs entrypoint selection'

# Invalid explicit runtimes fail before the child starts.
CHILD_MARKER="$TEST_ROOT/invalid-runtime-child"
expect_failure env FDRIVE_NODE="$BAD_NODE" FDRIVE_PNPM="$FAKE_PNPM" bash "$RUN" "$ROOT" -- touch "$CHILD_MARKER"
assert_no_file "$CHILD_MARKER"
expect_failure env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_PNPM_VERSION=9.9.9 \
  bash "$RUN" "$ROOT" -- touch "$CHILD_MARKER"
assert_no_file "$CHILD_MARKER"
pass 'invalid explicit Node and pnpm are rejected'

# Default discovery compares stable Node 24 candidates numerically; explicit selection still wins.
ACTIVE_NODE_DIR="$TEST_ROOT/active node/bin"
ACTIVE_NODE="$ACTIVE_NODE_DIR/node"
FAKE_NVM="$TEST_ROOT/fake nvm"
make_fake_node "$ACTIVE_NODE" 'v24.15.0'
make_fake_node "$FAKE_NVM/versions/node/v24.13.0/bin/node" 'v24.13.0'
make_fake_node "$FAKE_NVM/versions/node/v24.19.10/bin/node" 'v24.19.10'
make_fake_node "$FAKE_NVM/versions/node/v24.20.0/bin/node" 'v24.20.0'
make_fake_node "$FAKE_NVM/versions/node/v24.21.0-rc.1/bin/node" 'v24.21.0-rc.1'
expect_success env -u FDRIVE_NODE PATH="$ACTIVE_NODE_DIR:$PATH" NVM_DIR="$FAKE_NVM" \
  FDRIVE_PNPM="$FAKE_PNPM" bash "$RUN" "$ROOT" -- node --version
assert_eq "$(cat "$OUT")" 'v24.20.0'
expect_success env PATH="$ACTIVE_NODE_DIR:$PATH" NVM_DIR="$FAKE_NVM" FDRIVE_NODE="$ACTIVE_NODE" \
  FDRIVE_PNPM="$FAKE_PNPM" bash "$RUN" "$ROOT" -- node --version
assert_eq "$(cat "$OUT")" 'v24.15.0'
pass 'Node discovery selects newest stable candidate while explicit override wins'

# An executable pnpm probe sees the explicitly selected Node 24, even if PATH has Node 23.
BAD_PATH="$TEST_ROOT/bad path"
mkdir -p "$BAD_PATH"
ln -s "$BAD_NODE" "$BAD_PATH/node"
expect_success env PATH="$BAD_PATH:$PATH" FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  REQUIRE_NODE24_PROBE=1 bash "$RUN" "$ROOT" -- true
assert_contains "$PNPM_LOG" 'PROBE_NODE=<'
assert_not_contains "$PNPM_LOG" "PROBE_NODE=<$BAD_PATH/node>"
pass 'pnpm version probe uses selected Node 24'

# Default run is unlocked. Locked run contends with its own checkout and releases after failure.
LOCK=$(lock_path "$ROOT")
mkdir -p "$(dirname "$LOCK")"
mkdir "$LOCK"
expect_success runtime_env bash "$RUN" "$ROOT" -- true
expect_status 75 runtime_env bash "$RUN" "$ROOT" --lock -- true
rmdir "$LOCK"
expect_status 41 runtime_env bash "$RUN" "$ROOT" --lock -- bash -c 'exit 41'
assert_no_file "$LOCK"
[[ -d $ROOT/.fdrive-workflow && ! -L $ROOT/.fdrive-workflow ]] || fail 'workflow state directory was removed after unlock'
pass 'run lock is optional, fail-fast on contention, and released on failure'

# Worktrees use distinct checkout-local locks.
OTHER="$TEST_ROOT/other worktree"
git -C "$ROOT" worktree add -q -b other-fixture "$OTHER" HEAD
LOCK=$(lock_path "$ROOT")
OTHER_LOCK=$(lock_path "$OTHER")
[[ $LOCK != "$OTHER_LOCK" ]] || fail 'worktrees unexpectedly share a lock path'
mkdir -p "$(dirname "$LOCK")"
mkdir "$LOCK"
expect_success runtime_env bash "$RUN" "$OTHER" --lock -- true
rmdir "$LOCK"
pass 'separate worktrees have independent locks'

# Symlinked state and lock paths are rejected before a command can run.
new_repo
CHILD_MARKER="$TEST_ROOT/symlink-state-child"
STATE_OUTSIDE="$TEST_ROOT/state outside"
mkdir -p "$STATE_OUTSIDE"
ln -s "$STATE_OUTSIDE" "$ROOT/.fdrive-workflow"
expect_failure runtime_env bash "$RUN" "$ROOT" --lock -- touch "$CHILD_MARKER"
assert_no_file "$CHILD_MARKER"
rm "$ROOT/.fdrive-workflow"
mkdir "$ROOT/.fdrive-workflow"
LOCK_OUTSIDE="$TEST_ROOT/lock outside"
mkdir "$LOCK_OUTSIDE"
ln -s "$LOCK_OUTSIDE" "$(lock_path "$ROOT")"
expect_failure runtime_env bash "$RUN" "$ROOT" --lock -- touch "$CHILD_MARKER"
assert_no_file "$CHILD_MARKER"
[[ -L $(lock_path "$ROOT") ]] || fail 'helper removed a lock it did not own'
pass 'symlinked state and lock paths are rejected without owner cleanup'

# TERM reaches the child, wrapper waits for it, preserves its status, then releases the lock.
new_repo
SIGNAL_CHILD="$TEST_ROOT/signal-child.cjs"
SIGNAL_READY="$TEST_ROOT/signal-ready"
SIGNAL_SEEN="$TEST_ROOT/signal-seen"
SIGNAL_RELEASE="$TEST_ROOT/signal-release"
cat > "$SIGNAL_CHILD" <<'SIGNAL'
const fs = require("fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(process.env.SIGNAL_SEEN, "seen\n");
  const timer = setInterval(() => {
    if (fs.existsSync(process.env.SIGNAL_RELEASE)) {
      clearInterval(timer);
      process.exit(47);
    }
  }, 1);
});
fs.writeFileSync(process.env.SIGNAL_READY, "ready\n");
setInterval(() => {}, 1000);
SIGNAL
LOCK=$(lock_path "$ROOT")
env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" SIGNAL_READY="$SIGNAL_READY" \
  SIGNAL_SEEN="$SIGNAL_SEEN" SIGNAL_RELEASE="$SIGNAL_RELEASE" \
  bash "$RUN" "$ROOT" --lock -- node "$SIGNAL_CHILD" > "$OUT" 2> "$ERR" &
WRAPPER_PID=$!
BACKGROUND_PIDS="$BACKGROUND_PIDS $WRAPPER_PID"
wait_for_file "$SIGNAL_READY" || fail 'run wrapper child did not become ready'
assert_file "$LOCK"
kill -TERM "$WRAPPER_PID"
wait_for_file "$SIGNAL_SEEN" || fail 'run wrapper did not forward TERM'
assert_file "$LOCK"
kill -0 "$WRAPPER_PID" 2>/dev/null || fail 'wrapper exited before child completion'
: > "$SIGNAL_RELEASE"
set +e
wait "$WRAPPER_PID"
STATUS=$?
set -e
BACKGROUND_PIDS=''
[[ $STATUS -eq 47 ]] || fail "signal child status lost: $STATUS"
assert_no_file "$LOCK"
pass 'signal forwarding waits for child and preserves status before unlock'

# Nonterminal commands forward signals to descendants and keep the lock until the tree exits.
DESCENDANT="$TEST_ROOT/signal-descendant.cjs"
PARENT="$TEST_ROOT/signal-parent.cjs"
DESCENDANT_READY="$TEST_ROOT/descendant-ready"
DESCENDANT_SEEN="$TEST_ROOT/descendant-seen"
DESCENDANT_RELEASE="$TEST_ROOT/descendant-release"
PARENT_SEEN="$TEST_ROOT/parent-seen"
cat > "$DESCENDANT" <<'DESCENDANT'
const fs = require("fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(process.env.DESCENDANT_SEEN, "seen\n");
  const timer = setInterval(() => {
    if (fs.existsSync(process.env.DESCENDANT_RELEASE)) {
      clearInterval(timer);
      process.exit(61);
    }
  }, 1);
});
fs.writeFileSync(process.env.DESCENDANT_READY, "ready\n");
setInterval(() => {}, 1000);
DESCENDANT
cat > "$PARENT" <<'PARENT'
const fs = require("fs");
const { spawn } = require("child_process");
process.on("SIGTERM", () => fs.writeFileSync(process.env.PARENT_SEEN, "seen\n"));
const child = spawn(process.execPath, [process.env.DESCENDANT], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code === null ? 1 : code));
PARENT
LOCK=$(lock_path "$ROOT")
env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" DESCENDANT="$DESCENDANT" \
  DESCENDANT_READY="$DESCENDANT_READY" DESCENDANT_SEEN="$DESCENDANT_SEEN" \
  DESCENDANT_RELEASE="$DESCENDANT_RELEASE" PARENT_SEEN="$PARENT_SEEN" \
  bash "$RUN" "$ROOT" --lock -- node "$PARENT" > "$OUT" 2> "$ERR" &
WRAPPER_PID=$!
BACKGROUND_PIDS="$BACKGROUND_PIDS $WRAPPER_PID"
wait_for_file "$DESCENDANT_READY" || fail 'descendant did not become ready'
kill -TERM "$WRAPPER_PID"
wait_for_file "$PARENT_SEEN" || fail 'parent did not receive TERM'
if ! wait_for_file "$DESCENDANT_SEEN"; then
  : > "$DESCENDANT_RELEASE"
  kill "$WRAPPER_PID" 2>/dev/null || true
  wait "$WRAPPER_PID" 2>/dev/null || true
  BACKGROUND_PIDS=''
  fail 'descendant did not receive TERM'
fi
assert_file "$LOCK"
: > "$DESCENDANT_RELEASE"
set +e
wait "$WRAPPER_PID"
STATUS=$?
set -e
BACKGROUND_PIDS=''
[[ $STATUS -eq 61 ]] || fail "descendant status lost: $STATUS"
assert_no_file "$LOCK"
pass 'nonterminal signal forwarding covers descendants and unlocks after tree exit'

exercise_locked_helper_signal() {
  local LABEL=$1 BLOCK_COMMAND=$2 CHILD_STATUS=$3 EXPECTED_STATUS=$4
  shift 4
  BLOCK_READY="$TEST_ROOT/$LABEL-ready"
  BLOCK_SEEN="$TEST_ROOT/$LABEL-seen"
  BLOCK_RELEASE="$TEST_ROOT/$LABEL-release"
  BLOCK_PID_FILE="$TEST_ROOT/$LABEL-pid"
  export BLOCK_READY BLOCK_SEEN BLOCK_RELEASE BLOCK_PID_FILE
  env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_PNPM_BLOCK="$BLOCK_COMMAND" \
    BLOCK_EXIT_CODE="$CHILD_STATUS" "$@" > "$OUT" 2> "$ERR" &
  local WRAPPER=$!
  BACKGROUND_PIDS="$BACKGROUND_PIDS $WRAPPER"
  if ! wait_for_file "$BLOCK_READY"; then
    kill "$WRAPPER" 2>/dev/null || true
    fail "$LABEL helper did not reach blocking child"
  fi
  local HELD_LOCK
  HELD_LOCK=$(lock_path "$ROOT")
  assert_file "$HELD_LOCK"
  kill -TERM "$WRAPPER"
  if ! wait_for_file "$BLOCK_SEEN"; then
    : > "$BLOCK_RELEASE"
    kill "$(cat "$BLOCK_PID_FILE")" 2>/dev/null || true
    wait "$WRAPPER" 2>/dev/null || true
    BACKGROUND_PIDS=''
    fail "$LABEL did not forward TERM to its child"
  fi
  assert_file "$HELD_LOCK"
  kill -0 "$WRAPPER" 2>/dev/null || fail "$LABEL unlocked before child completion"
  : > "$BLOCK_RELEASE"
  set +e
  wait "$WRAPPER"
  STATUS=$?
  set -e
  BACKGROUND_PIDS=''
  [[ $STATUS -eq $EXPECTED_STATUS ]] || fail "$LABEL signal status: expected $EXPECTED_STATUS, got $STATUS"
  assert_no_file "$HELD_LOCK"
  HELPER_LOG_OUT=$(find "$ROOT/.fdrive-workflow/logs" -name stdout.log -type f -print | tail -n 1)
  assert_file "$HELPER_LOG_OUT"
}

# Setup and verify also forward termination and keep their lock until the gate exits.
new_repo
exercise_locked_helper_signal setup 'install --frozen-lockfile' 53 53 bash "$SETUP" "$ROOT"
new_repo
exercise_locked_helper_signal verify lint 53 53 bash "$VERIFY" "$ROOT" application
new_repo
exercise_locked_helper_signal verify-cancel lint 0 143 bash "$VERIFY" "$ROOT" application
[[ $(grep -c '^CALL' "$PNPM_LOG") -eq 1 ]] || fail 'verify continued gates after TERM child exited zero'
assert_not_contains "$PNPM_LOG" '<typecheck>'
pass 'locked helpers forward signals, preserve failures, cancel zero exits, and unlock last'

# Setup installs frozen, builds the declared binary, relinks, and is repeatable.
new_repo
expect_success runtime_env bash "$SETUP" "$ROOT"
expect_success runtime_env bash "$SETUP" "$ROOT"
[[ $(grep -c '^CALL' "$PNPM_LOG") -eq 8 ]] || fail 'setup did not run store preflight and three pnpm steps per invocation'
[[ $(grep -c '^CALL <store> <path>' "$PNPM_LOG") -eq 2 ]] || fail 'setup store preflight count mismatch'
[[ $(grep -c '^CALL <install> <--frozen-lockfile>' "$PNPM_LOG") -eq 4 ]] || fail 'setup frozen install count mismatch'
[[ $(grep -c '^CALL <--filter> <@fdrive/db...> <run> <build>' "$PNPM_LOG") -eq 2 ]] || fail 'setup build count mismatch'
[[ $(grep '^CALL <install> <--frozen-lockfile>' "$PNPM_LOG" | grep -c 'CI=<true>') -eq 4 ]] || fail 'setup frozen installs did not force CI=true'
[[ $(grep '^CALL <--filter> <@fdrive/db...> <run> <build>' "$PNPM_LOG" | grep -c 'CI=<>') -eq 2 ]] || fail 'setup leaked CI=true into build'
assert_eq "$(cat "$PNPM_COMMAND_LOG")" $'store path\ninstall --frozen-lockfile\n--filter @fdrive/db... run build\ninstall --frozen-lockfile\nstore path\ninstall --frozen-lockfile\n--filter @fdrive/db... run build\ninstall --frozen-lockfile'
assert_file "$ROOT/packages/db/dist/bin/migrate.js"
[[ -x $ROOT/apps/api/node_modules/.bin/fdrive-migrate ]] || fail 'linked migration shim is not executable'
assert_no_file "$MIGRATION_MARKER"
pass 'setup frozen install-build-relink sequence is repeatable without migrations'

# Setup preserves exact child failures and rejects missing build output or linked shim.
new_repo
expect_status 29 env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  FAKE_PNPM_FAIL='--filter @fdrive/db... run build' FAKE_PNPM_FAIL_CODE=29 bash "$SETUP" "$ROOT"
[[ $(grep -c '^CALL' "$PNPM_LOG") -eq 3 ]] || fail 'setup continued after failed build'
assert_no_file "$(lock_path "$ROOT")"
new_repo
expect_failure env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_SKIP_BUILD=1 bash "$SETUP" "$ROOT"
assert_no_file "$ROOT/packages/db/dist/bin/migrate.js"
new_repo
expect_failure env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_SKIP_SHIM=1 bash "$SETUP" "$ROOT"
assert_file "$ROOT/packages/db/dist/bin/migrate.js"
pass 'setup fail-fast status, build output, linked shim, and lock cleanup'

# Store mismatch refuses installation without deleting or changing existing dependencies.
new_repo
mkdir -p "$ROOT/node_modules"
printf 'storeDir: %s\n' "$TEST_ROOT/different store" > "$ROOT/node_modules/.modules.yaml"
printf 'preserve me\n' > "$ROOT/node_modules/preserved-marker"
expect_failure runtime_env bash "$SETUP" "$ROOT"
assert_eq "$(cat "$ROOT/node_modules/preserved-marker")" 'preserve me'
assert_eq "$(cat "$PNPM_COMMAND_LOG")" 'store path'
assert_not_contains "$PNPM_LOG" '<install>'
assert_not_contains "$PNPM_LOG" '<build>'
pass 'setup rejects pnpm store mismatch before touching dependencies'

# Equivalent physical stores pass when metadata is quoted and pnpm reports a symlink path.
new_repo
PHYSICAL_STORE="$TEST_ROOT/physical pnpm store"
STORE_LINK="$TEST_ROOT/pnpm store link"
mkdir -p "$PHYSICAL_STORE" "$ROOT/node_modules"
ln -s "$PHYSICAL_STORE" "$STORE_LINK"
printf "storeDir: '%s'\n" "$PHYSICAL_STORE" > "$ROOT/node_modules/.modules.yaml"
expect_success env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_STORE_PATH="$STORE_LINK" \
  bash "$SETUP" "$ROOT"
assert_contains "$PNPM_COMMAND_LOG" 'install --frozen-lockfile'
pass 'setup accepts quoted and symlink-equivalent pnpm store paths'

# Prepare creates codex/<chunk> from committed HEAD at a space-containing destination.
new_repo
printf 'dirty source\n' > "$ROOT/uncommitted-source.txt"
SOURCE_HEAD=$(git -C "$ROOT" rev-parse HEAD)
DESTINATION="$TEST_ROOT/prepared checkout with spaces"
expect_success from_outside env FDRIVE_VERBOSE=1 FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  bash "$PREPARE" "$ROOT" helper_chunk "$DESTINATION"
assert_eq "$(cat "$OUT")" "$(cd "$DESTINATION" && pwd -P)"
assert_eq "$(git -C "$DESTINATION" branch --show-current)" 'codex/helper_chunk'
assert_eq "$(git -C "$DESTINATION" rev-parse HEAD)" "$SOURCE_HEAD"
assert_no_file "$DESTINATION/uncommitted-source.txt"
assert_contains "$PNPM_LOG" "PWD=<$DESTINATION>"
pass 'prepare uses committed HEAD, exact branch, explicit destination, and clean stdout'

# Prepare validates before creation and retains a checkout after setup failure.
new_repo
REJECTED_DEST="$TEST_ROOT/rejected destination"
expect_failure env FDRIVE_NODE="$BAD_NODE" FDRIVE_PNPM="$FAKE_PNPM" \
  bash "$PREPARE" "$ROOT" runtime_check "$REJECTED_DEST"
assert_no_file "$REJECTED_DEST"
git -C "$ROOT" show-ref --verify --quiet refs/heads/codex/runtime_check && fail 'branch created before runtime validation'
FAILED_DEST="$TEST_ROOT/retained failed checkout"
expect_status 31 env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  FAKE_PNPM_FAIL='install --frozen-lockfile' FAKE_PNPM_FAIL_CODE=31 \
  bash "$PREPARE" "$ROOT" retained_failure "$FAILED_DEST"
assert_file "$FAILED_DEST/.git"
git -C "$ROOT" show-ref --verify --quiet refs/heads/codex/retained_failure || fail 'failed branch was removed'
assert_contains "$ERR" "$FAILED_DEST"
pass 'prepare validates runtime first and retains failed setup for recovery'

# Prepare forwards TERM through nested setup and retains the interrupted checkout.
new_repo
PREPARED_SIGNAL_DEST="$TEST_ROOT/prepare signal checkout"
BLOCK_READY="$TEST_ROOT/prepare-signal-ready"
BLOCK_SEEN="$TEST_ROOT/prepare-signal-seen"
BLOCK_RELEASE="$TEST_ROOT/prepare-signal-release"
BLOCK_PID_FILE="$TEST_ROOT/prepare-signal-pid"
export BLOCK_READY BLOCK_SEEN BLOCK_RELEASE BLOCK_PID_FILE
env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_PNPM_BLOCK='install --frozen-lockfile' \
  BLOCK_EXIT_CODE=53 bash "$PREPARE" "$ROOT" signal_setup "$PREPARED_SIGNAL_DEST" > "$OUT" 2> "$ERR" &
PREPARE_PID=$!
BACKGROUND_PIDS="$BACKGROUND_PIDS $PREPARE_PID"
wait_for_file "$BLOCK_READY" || fail 'prepare nested setup did not reach blocking install'
PREPARED_LOCK=$(lock_path "$PREPARED_SIGNAL_DEST")
assert_file "$PREPARED_LOCK"
kill -TERM "$PREPARE_PID"
if ! wait_for_file "$BLOCK_SEEN"; then
  : > "$BLOCK_RELEASE"
  kill "$(cat "$BLOCK_PID_FILE")" 2>/dev/null || true
  wait "$PREPARE_PID" 2>/dev/null || true
  BACKGROUND_PIDS=''
  fail 'prepare did not forward TERM through setup to install'
fi
assert_file "$PREPARED_LOCK"
: > "$BLOCK_RELEASE"
set +e
wait "$PREPARE_PID"
STATUS=$?
set -e
BACKGROUND_PIDS=''
[[ $STATUS -eq 53 ]] || fail "prepare lost nested setup status: $STATUS"
assert_no_file "$PREPARED_LOCK"
assert_file "$PREPARED_SIGNAL_DEST/.git"
assert_eq "$(git -C "$PREPARED_SIGNAL_DEST" branch --show-current)" 'codex/signal_setup'
pass 'prepare forwards signals through setup and retains interrupted checkout'

# Verify workflow runs syntax, TOML, Python syntax, every regression script, lint, and diff check without recursion.
new_repo
cat > "$ROOT/tools/orchestration/test-discovered.sh" <<'STUB'
#!/bin/bash
set -euo pipefail
printf '%s PWD=<%s>\n' "$(basename "$0")" "$PWD" >> "$TOOL_LOG"
STUB
chmod +x "$ROOT/tools/orchestration/test-discovered.sh"
printf 'value = 1\n' > "$ROOT/tools/orchestration/helper.py"
expect_success runtime_env bash "$VERIFY" "$ROOT" workflow
assert_contains "$TOOL_LOG" 'python3 <-c>'
assert_contains "$TOOL_LOG" "test-orchestration.sh PWD=<$ROOT>"
assert_contains "$TOOL_LOG" "test-command-helpers.sh PWD=<$ROOT>"
assert_contains "$TOOL_LOG" "test-discovered.sh PWD=<$ROOT>"
assert_no_file "$ROOT/tools/orchestration/__pycache__"
[[ $(grep -c '^CALL <lint>' "$PNPM_LOG") -eq 1 ]] || fail 'workflow lint missing or duplicated'
pass 'workflow profile checks Python syntax and discovers fixture regression scripts once'

# Package validation is exact; successful package verification runs the expected sequence.
new_repo
expect_failure runtime_env bash "$VERIFY" "$ROOT" package '@fdrive/*'
[[ ! -s $PNPM_LOG ]] || fail 'invalid package pattern started gates'
expect_failure runtime_env bash "$VERIFY" "$ROOT" package '@fdrive/missing'
[[ ! -s $PNPM_LOG ]] || fail 'unknown package started gates'
mkdir -p "$ROOT/arbitrary/deep"
printf '%s\n' '{"name":"@fdrive/hidden","private":true}' > "$ROOT/arbitrary/deep/package.json"
expect_failure runtime_env bash "$VERIFY" "$ROOT" package '@fdrive/hidden'
[[ ! -s $PNPM_LOG ]] || fail 'out-of-workspace manifest started gates'
expect_success runtime_env bash "$VERIFY" "$ROOT" package '@fdrive/core'
assert_contains "$PNPM_LOG" 'CALL <lint>'
assert_contains "$PNPM_LOG" 'CALL <--filter> <@fdrive/core> <typecheck>'
assert_contains "$PNPM_LOG" 'CALL <--filter> <@fdrive/core> <test:coverage>'
[[ $(grep -c '^CALL' "$PNPM_LOG") -eq 3 ]] || fail 'package profile ran unexpected pnpm steps'
pass 'package profile validates exact names and runs lint, typecheck, coverage'

# Application fails fast with exact status. Fixed profiles reject extra arguments before gates.
new_repo
expect_status 33 env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  FAKE_PNPM_FAIL=typecheck FAKE_PNPM_FAIL_CODE=33 bash "$VERIFY" "$ROOT" application
[[ $(grep -c '^CALL' "$PNPM_LOG") -eq 2 ]] || fail 'application did not fail fast'
assert_not_contains "$PNPM_LOG" '<test:coverage>'
: > "$PNPM_LOG"
expect_failure runtime_env bash "$VERIFY" "$ROOT" integration extra
[[ ! -s $PNPM_LOG ]] || fail 'fixed profile extra args started gates'
expect_success runtime_env bash "$VERIFY" "$ROOT" integration
assert_contains "$PNPM_LOG" 'CALL <test:integration>'
[[ $(grep -c '^CALL' "$PNPM_LOG") -eq 1 ]] || fail 'integration ran unrelated application gates'
pass 'application fail-fast and fixed-profile argument validation'

# Browser forwards Playwright arguments and existing port environment unchanged.
new_repo
expect_success env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  E2E_API_PORT=43101 E2E_WEB_PORT=43102 bash "$VERIFY" "$ROOT" browser \
  '--project=chromium' 'e2e/path with spaces.spec.ts'
assert_contains "$PNPM_LOG" 'CALL <--filter> <@fdrive/web> <test:e2e> <--project=chromium> <e2e/path with spaces.spec.ts>'
assert_contains "$PNPM_LOG" 'PORTS=<43101,43102>'
[[ $(grep -c '^CALL' "$PNPM_LOG") -eq 1 ]] || fail 'browser ran unrelated gates'
: > "$PNPM_LOG"
expect_success env -u E2E_API_PORT -u E2E_WEB_PORT FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" \
  bash "$VERIFY" "$ROOT" browser
assert_contains "$PNPM_LOG" 'PORTS=<,>'
pass 'browser profile preserves explicit ports and leaves omitted ports to Playwright harness'

# Python dispatch uses service-local tools, optional scripts, coverage module, and indexer Docker check.
new_repo
for SERVICE in indexer ocr image-embed; do
  mkdir -p "$ROOT/services/$SERVICE/.venv/bin" "$ROOT/services/$SERVICE/src" "$ROOT/services/$SERVICE/tests"
  make_tool "$ROOT/services/$SERVICE/.venv/bin/ruff"
  make_tool "$ROOT/services/$SERVICE/.venv/bin/mypy"
  make_tool "$ROOT/services/$SERVICE/.venv/bin/pytest"
done
mkdir -p "$ROOT/services/indexer/scripts"
make_tool "$ROOT/services/indexer/scripts/test-in-docker.sh"
mkdir -p "$ROOT/services/image-embed/scripts"
expect_success runtime_env bash "$VERIFY" "$ROOT" python indexer
assert_contains "$TOOL_LOG" "ruff <check> <src> <tests> <scripts> PWD=<$ROOT/services/indexer>"
assert_contains "$TOOL_LOG" "mypy <src> <scripts> PWD=<$ROOT/services/indexer>"
assert_contains "$TOOL_LOG" 'pytest <-q> <--cov=fdrive_indexer> <--cov-report=term-missing> <--cov-fail-under=95>'
assert_contains "$TOOL_LOG" "test-in-docker.sh PWD=<$ROOT/services/indexer>"
: > "$TOOL_LOG"
expect_success runtime_env bash "$VERIFY" "$ROOT" python ocr
assert_contains "$TOOL_LOG" 'pytest <-q> <--cov=fdrive_ocr>'
assert_not_contains "$TOOL_LOG" '<scripts>'
assert_not_contains "$TOOL_LOG" 'test-in-docker.sh'
: > "$TOOL_LOG"
expect_success runtime_env bash "$VERIFY" "$ROOT" python image-embed
assert_contains "$TOOL_LOG" 'pytest <-q> <--cov=fdrive_image_embed>'
assert_contains "$TOOL_LOG" 'ruff <check> <src> <tests> <scripts>'
: > "$TOOL_LOG"
expect_failure runtime_env bash "$VERIFY" "$ROOT" python unknown
[[ ! -s $TOOL_LOG ]] || fail 'unknown Python service started tools'
pass 'python profiles dispatch tools, scripts, coverage, and indexer Docker check'

printf '%s command helper regression groups passed.\n' "$PASSES"
