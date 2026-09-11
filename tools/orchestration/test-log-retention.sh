#!/bin/bash
# Regression tests for bounded step-log retention. Disposable fixtures only; no Git, no network.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=command-lib.sh
source "$SCRIPT_DIR/command-lib.sh"
FDRIVE_COMMAND_NAME=log-retention-test
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fdrive-log-retention-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT
PASSES=0
fail() { printf 'test-log-retention: %s\n' "$1" >&2; exit 1; }
pass() { PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$1"; }

# Builds $1 step directories with strictly increasing mtimes: step.1 oldest, step.N newest.
fixture() {
  local root count index stamp
  root="$TEST_ROOT/$1"
  count=$2
  rm -rf "$root"
  mkdir -p "$root/.fdrive-workflow/logs"
  for ((index = 1; index <= count; index++)); do
    mkdir -p "$root/.fdrive-workflow/logs/step.$index"
    printf 'log\n' > "$root/.fdrive-workflow/logs/step.$index/stdout.log"
    stamp=$(printf '202601%02d0000' "$index")
    touch -t "$stamp" "$root/.fdrive-workflow/logs/step.$index"
  done
  FIXTURE="$root"
}

present() { test -e "$FIXTURE/.fdrive-workflow/logs/$1"; }
remaining() { find "$FIXTURE/.fdrive-workflow/logs" -maxdepth 1 -type d -name 'step.*' | wc -l | tr -d ' '; }

fixture keep 5
FDRIVE_LOG_RETENTION_COUNT=2 fdrive_initialize_logs "$FIXTURE" >/dev/null
[[ $(remaining) -eq 2 ]] || fail "expected 2 survivors, found $(remaining)"
present step.5 || fail 'newest step was pruned'
present step.4 || fail 'second newest step was pruned'
! present step.3 || fail 'older step survived the cap'
! present step.1 || fail 'oldest step survived the cap'
pass 'cap keeps the newest directories and drops the rest'

fixture under 3
FDRIVE_LOG_RETENTION_COUNT=10 fdrive_initialize_logs "$FIXTURE" >/dev/null
[[ $(remaining) -eq 3 ]] || fail 'pruned below the cap'
pass 'a directory count under the cap is left alone'

fixture disabled 5
FDRIVE_LOG_RETENTION_COUNT=0 fdrive_initialize_logs "$FIXTURE" >/dev/null
[[ $(remaining) -eq 5 ]] || fail 'zero did not disable pruning'
FDRIVE_LOG_RETENTION_COUNT=notanumber fdrive_initialize_logs "$FIXTURE" >/dev/null
[[ $(remaining) -eq 5 ]] || fail 'malformed value pruned anyway'
FDRIVE_LOG_RETENTION_COUNT=-4 fdrive_initialize_logs "$FIXTURE" >/dev/null
[[ $(remaining) -eq 5 ]] || fail 'negative value pruned anyway'
pass 'zero disables pruning and malformed values prune nothing'

fixture scoped 4
mkdir -p "$FIXTURE/.fdrive-workflow/logs/keepme"
printf 'x\n' > "$FIXTURE/.fdrive-workflow/logs/notes.txt"
ln -s "$FIXTURE/.fdrive-workflow/logs/keepme" "$FIXTURE/.fdrive-workflow/logs/step.link"
FDRIVE_LOG_RETENTION_COUNT=1 fdrive_initialize_logs "$FIXTURE" >/dev/null
present keepme || fail 'unrelated directory removed'
present notes.txt || fail 'unrelated file removed'
present step.link || fail 'symlink named step.* was removed'
test -d "$FIXTURE/.fdrive-workflow/logs/keepme" || fail 'symlink target was followed and deleted'
pass 'pruning is scoped to real step directories and never follows symlinks'

fixture default 2
fdrive_initialize_logs "$FIXTURE" >/dev/null
[[ $(remaining) -eq 2 ]] || fail 'default cap pruned a small fixture'
[[ -n ${FDRIVE_LOG_DIRECTORY:-} ]] || fail 'log directory was not published'
pass 'default cap leaves small log directories untouched'

printf '%s log retention regression groups passed.\n' "$PASSES"
