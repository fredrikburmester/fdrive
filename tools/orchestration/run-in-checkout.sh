#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=command-lib.sh
source "$SCRIPT_DIR/command-lib.sh"
FDRIVE_COMMAND_NAME=run-in-checkout
FDRIVE_RUNTIME_DIR=
FDRIVE_LOCK_STATE_PATH=
FDRIVE_LOCK_PATH=
FDRIVE_LOCK_TOKEN=
FDRIVE_CHILD_PID=
FDRIVE_CHILD_GROUP=0
FDRIVE_SIGNAL_STATUS=0
FDRIVE_COMMAND_FAILURE_REPORTED=0

usage() {
  printf '%s\n' \
    'usage: bash run-in-checkout.sh <checkout> [--lock] -- <command> [args...]' \
    '       FDRIVE_VERBOSE=1 prints full output for locked commands.'
}

if [[ ${1:-} == --help && $# -eq 1 ]]; then usage; exit 0; fi
[[ $# -ge 3 ]] || { usage >&2; exit 1; }
CHECKOUT_ARG=$1
shift
USE_LOCK=0
if [[ ${1:-} == --lock ]]; then USE_LOCK=1; shift; fi
[[ ${1:-} == -- ]] || { usage >&2; exit 1; }
shift
[[ $# -gt 0 ]] || { usage >&2; exit 1; }

CHECKOUT=$(fdrive_resolve_checkout "$CHECKOUT_ARG") || exit $?

finish() {
  local status=$?
  trap - EXIT INT TERM
  fdrive_release_lock
  fdrive_cleanup_runtime
  if [[ $status -ne 0 && $FDRIVE_COMMAND_FAILURE_REPORTED -eq 0 ]]; then
    printf '%s: FAIL command (exit %s)\n' "$FDRIVE_COMMAND_NAME" "$status" >&2
  fi
  exit "$status"
}

trap finish EXIT
trap 'fdrive_handle_signal INT 130' INT
trap 'fdrive_handle_signal TERM 143' TERM
fdrive_prepare_runtime "$CHECKOUT"
if [[ $USE_LOCK -eq 1 ]]; then fdrive_acquire_lock "$CHECKOUT"; fi
cd "$CHECKOUT"
if [[ $USE_LOCK -eq 1 ]]; then
  if fdrive_run_step 'command' "$@"; then
    exit 0
  else
    STATUS=$?
    FDRIVE_COMMAND_FAILURE_REPORTED=1
    exit "$STATUS"
  fi
fi
fdrive_run_child "$@"
