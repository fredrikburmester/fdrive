#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=command-lib.sh
source "$SCRIPT_DIR/command-lib.sh"
FDRIVE_COMMAND_NAME=prepare-worktree
FDRIVE_RUNTIME_DIR=
FDRIVE_LOCK_STATE_PATH=
FDRIVE_LOCK_PATH=
FDRIVE_LOCK_TOKEN=
FDRIVE_CHILD_PID=
FDRIVE_CHILD_GROUP=0
FDRIVE_SIGNAL_STATUS=0

usage() {
  printf 'usage: bash prepare-worktree.sh <source-checkout> <chunk> [destination] [--working-tree]\n'
}

if [[ ${1:-} == --help && $# -eq 1 ]]; then usage; exit 0; fi
[[ $# -ge 2 && $# -le 4 ]] || { usage >&2; exit 1; }
SOURCE=$(fdrive_resolve_checkout "$1") || exit $?
CHUNK=$2
[[ $CHUNK =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fdrive_die 'chunk must match [a-z0-9][a-z0-9_-]*'
BRANCH="claude/$CHUNK"
WORKING_TREE=0
DESTINATION=
shift 2
for ARG in "$@"; do
  if [[ $ARG == --working-tree ]]; then
    [[ $WORKING_TREE -eq 0 ]] || fdrive_die '--working-tree may appear once'
    WORKING_TREE=1
  elif [[ -z $DESTINATION ]]; then
    if [[ $ARG == /* ]]; then DESTINATION=$ARG; else DESTINATION="$PWD/$ARG"; fi
  else
    fdrive_die 'only one destination is allowed'
  fi
done
if [[ -z $DESTINATION ]]; then DESTINATION="$SOURCE/.worktrees/$CHUNK"; fi
[[ ! -e $DESTINATION && ! -L $DESTINATION ]] || fdrive_die "destination already exists: $DESTINATION"
git -C "$SOURCE" show-ref --verify --quiet "refs/heads/$BRANCH" && fdrive_die "branch already exists: $BRANCH"

finish() {
  local status=$?
  trap - EXIT INT TERM
  fdrive_release_lock
  fdrive_cleanup_runtime
  printf '%s: end status %s\n' "$FDRIVE_COMMAND_NAME" "$status" >&2
  exit "$status"
}

trap finish EXIT
trap 'fdrive_handle_signal INT 130' INT
trap 'fdrive_handle_signal TERM 143' TERM
printf '%s: start source %s chunk %s\n' "$FDRIVE_COMMAND_NAME" "$SOURCE" "$CHUNK" >&2
fdrive_prepare_runtime "$SOURCE"
fdrive_acquire_lock "$SOURCE"
fdrive_run_step 'worktree creation' git -C "$SOURCE" worktree add -b "$BRANCH" "$DESTINATION" HEAD >&2
DESTINATION=$(fdrive_resolve_checkout "$DESTINATION")
fdrive_release_lock
fdrive_cleanup_runtime

if [[ $WORKING_TREE -eq 1 ]]; then
  if fdrive_run_child python3 "$SCRIPT_DIR/transfer-checkout.py" baseline "$SOURCE" "$DESTINATION" >&2; then
    :
  else
    STATUS=$?
    printf '%s: baseline copy failed; retained checkout %s and branch %s\n' "$FDRIVE_COMMAND_NAME" "$DESTINATION" "$BRANCH" >&2
    exit "$STATUS"
  fi
fi

if fdrive_run_child bash "$SCRIPT_DIR/setup-checkout.sh" "$DESTINATION" >&2; then
  printf '%s\n' "$DESTINATION"
else
  STATUS=$?
  printf '%s: setup failed; retained checkout %s and branch %s\n' "$FDRIVE_COMMAND_NAME" "$DESTINATION" "$BRANCH" >&2
  printf '%s: recover by fixing prerequisites, then run: bash %s %q\n' "$FDRIVE_COMMAND_NAME" "$SCRIPT_DIR/setup-checkout.sh" "$DESTINATION" >&2
  exit "$STATUS"
fi
