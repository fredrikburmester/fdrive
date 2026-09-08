#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=command-lib.sh
source "$SCRIPT_DIR/command-lib.sh"
FDRIVE_COMMAND_NAME=setup-python
FDRIVE_LOCK_STATE_PATH=
FDRIVE_LOCK_PATH=
FDRIVE_LOCK_TOKEN=
FDRIVE_CHILD_PID=
FDRIVE_CHILD_GROUP=0
FDRIVE_SIGNAL_STATUS=0

usage() {
  printf 'usage: bash setup-python.sh <checkout> <indexer|ocr|image-embed|runtime>\n'
}

python_version() {
  "$1" -c 'import sys; print("%d %d %d" % sys.version_info[:3])' 2>/dev/null
}

python_is_supported() {
  local version major minor patch
  version=$(python_version "$1") || return 1
  [[ $version =~ ^([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+([0-9]+)$ ]] || return 1
  major=${BASH_REMATCH[1]}
  minor=${BASH_REMATCH[2]}
  patch=${BASH_REMATCH[3]}
  (( major > 3 || (major == 3 && minor >= 12) )) || return 1
  printf '%s %s %s\n' "$major" "$minor" "$patch"
}

select_python() {
  local candidate resolved
  if [[ -n ${FDRIVE_PYTHON:-} ]]; then
    resolved=$(fdrive_resolve_executable "$FDRIVE_PYTHON") || {
      printf '%s: FDRIVE_PYTHON is not executable: %s\n' "$FDRIVE_COMMAND_NAME" "$FDRIVE_PYTHON" >&2
      return 1
    }
    python_is_supported "$resolved" >/dev/null || {
      printf '%s: FDRIVE_PYTHON must run Python 3.12 or newer: %s\n' "$FDRIVE_COMMAND_NAME" "$resolved" >&2
      return 1
    }
    printf '%s\n' "$resolved"
    return 0
  fi

  for candidate in python3.12 python3 python; do
    resolved=$(fdrive_resolve_executable "$candidate" 2>/dev/null || true)
    [[ -n $resolved ]] || continue
    python_is_supported "$resolved" >/dev/null || continue
    printf '%s\n' "$resolved"
    return 0
  done
  printf '%s: Python 3.12 or newer is required; set FDRIVE_PYTHON to an installed interpreter\n' "$FDRIVE_COMMAND_NAME" >&2
  return 1
}

verify_venv_python() {
  local expected=$1 interpreter=$2
  [[ -d $expected && ! -L $expected && -d $expected/bin && ! -L $expected/bin && -x $interpreter ]] || return 1
  "$interpreter" -c '
import os
import sys
expected = os.path.realpath(sys.argv[1])
if os.path.realpath(sys.prefix) != expected or sys.prefix == sys.base_prefix:
    raise SystemExit(1)
' "$expected"
}

if [[ ${1:-} == --help && $# -eq 1 ]]; then usage; exit 0; fi
[[ $# -eq 2 ]] || { usage >&2; exit 1; }
CHECKOUT=$(fdrive_resolve_checkout "$1") || exit $?
SERVICE=$2
case "$SERVICE" in indexer|ocr|image-embed|runtime) ;; *) usage >&2; exit 1 ;; esac
SERVICE_DIR="$CHECKOUT/services/$SERVICE"
[[ -d $SERVICE_DIR ]] || fdrive_die "service directory is missing: $SERVICE_DIR"
[[ ! -L "$CHECKOUT/services" && ! -L $SERVICE_DIR ]] || fdrive_die "service directory must not be a symlink: $SERVICE_DIR"

finish() {
  local status=$?
  trap - EXIT INT TERM
  fdrive_release_lock
  printf '%s: end service %s status %s\n' "$FDRIVE_COMMAND_NAME" "$SERVICE" "$status" >&2
  exit "$status"
}

trap finish EXIT
trap 'fdrive_handle_signal INT 130' INT
trap 'fdrive_handle_signal TERM 143' TERM
printf '%s: start service %s checkout %s\n' "$FDRIVE_COMMAND_NAME" "$SERVICE" "$CHECKOUT" >&2
fdrive_acquire_lock "$CHECKOUT"
cd "$SERVICE_DIR"
if [[ -e .venv || -L .venv ]]; then
  verify_venv_python "$SERVICE_DIR/.venv" .venv/bin/python || fdrive_die "existing virtual environment is invalid: $SERVICE_DIR/.venv"
  python_is_supported .venv/bin/python >/dev/null || fdrive_die "existing virtual environment must run Python 3.12 or newer: $SERVICE_DIR/.venv"
else
  FDRIVE_SELECTED_PYTHON=$(select_python) || exit $?
  fdrive_run_step "$SERVICE virtual environment" "$FDRIVE_SELECTED_PYTHON" -m venv .venv
  verify_venv_python "$SERVICE_DIR/.venv" .venv/bin/python || fdrive_die "created virtual environment is invalid: $SERVICE_DIR/.venv"
fi
fdrive_run_step "$SERVICE editable development install" env PIP_DISABLE_PIP_VERSION_CHECK=1 .venv/bin/python -m pip install -e '.[dev]'
