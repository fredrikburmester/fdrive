#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=command-lib.sh
source "$SCRIPT_DIR/command-lib.sh"
FDRIVE_COMMAND_NAME=dev-app
FDRIVE_RUNTIME_DIR=
FDRIVE_LOCK_STATE_PATH=
FDRIVE_LOCK_PATH=
FDRIVE_LOCK_TOKEN=
FDRIVE_CHILD_PID=
FDRIVE_CHILD_GROUP=0
FDRIVE_SIGNAL_STATUS=0
API_PORT=3001
WEB_PORT=3002
WITH_INDEX=0
READY_TIMEOUT_SECONDS=${FDRIVE_DEV_READY_TIMEOUT_SECONDS:-45}
API_PID=
WEB_PID=
LOG_DIR=

usage() {
  printf '%s\n' 'usage: bash dev-app.sh <checkout> [--web-port N] [--index]'
}

valid_port() {
  [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1024 && $1 <= 65535 ))
}

valid_timeout() {
  [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 300 ))
}

require_free_port() {
  local port=$1 status
  command -v lsof >/dev/null 2>&1 || fdrive_die 'lsof is required to check development ports'
  set +e
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then fdrive_die "port is already in use: $port"; fi
  [[ $status -eq 1 ]] || fdrive_die "could not check port availability: $port"
}

stop_server() {
  local pid=$1 waited=0
  [[ -n $pid ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  while kill -0 -- "-$pid" 2>/dev/null && (( waited < 10 )); do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 -- "-$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  wait "$pid" 2>/dev/null || true
}

stop_servers() {
  stop_server "$API_PID"
  stop_server "$WEB_PID"
  API_PID=
  WEB_PID=
  set +m 2>/dev/null || true
}

wait_for_http() {
  local url=$1 label=$2 started=$SECONDS
  while (( SECONDS - started < READY_TIMEOUT_SECONDS )); do
    [[ ${FDRIVE_SIGNAL_STATUS:-0} -eq 0 ]] || return "$FDRIVE_SIGNAL_STATUS"
    if [[ -n $API_PID ]] && ! kill -0 "$API_PID" 2>/dev/null; then return 1; fi
    if [[ -n $WEB_PID ]] && ! kill -0 "$WEB_PID" 2>/dev/null; then return 1; fi
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  printf '%s: %s did not become ready within %s seconds\n' "$FDRIVE_COMMAND_NAME" "$label" "$READY_TIMEOUT_SECONDS" >&2
  return 1
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  stop_servers
  fdrive_release_lock
  fdrive_cleanup_runtime
  [[ -z $LOG_DIR ]] || printf '%s: logs saved in %s\n' "$FDRIVE_COMMAND_NAME" "$LOG_DIR" >&2
  printf '%s: end status %s\n' "$FDRIVE_COMMAND_NAME" "$status" >&2
  exit "$status"
}

if [[ ${1:-} == --help && $# -eq 1 ]]; then usage; exit 0; fi
[[ $# -ge 1 ]] || { usage >&2; exit 1; }
CHECKOUT=$(fdrive_resolve_checkout "$1") || exit $?
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --index) WITH_INDEX=1; shift ;;
    --web-port)
      [[ $# -ge 2 ]] || { usage >&2; exit 1; }
      WEB_PORT=$2
      valid_port "$WEB_PORT" || { usage >&2; exit 1; }
      shift 2
      ;;
    *) usage >&2; exit 1 ;;
  esac
done
[[ $WEB_PORT -ne $API_PORT ]] || fdrive_die "web port must differ from API port: $API_PORT"
valid_timeout "$READY_TIMEOUT_SECONDS" || fdrive_die 'FDRIVE_DEV_READY_TIMEOUT_SECONDS must be between 1 and 300'

trap finish EXIT
trap 'fdrive_handle_signal INT 130' INT
trap 'fdrive_handle_signal TERM 143' TERM
printf '%s: start checkout %s\n' "$FDRIVE_COMMAND_NAME" "$CHECKOUT" >&2
fdrive_prepare_runtime "$CHECKOUT"
require_free_port "$API_PORT"
require_free_port "$WEB_PORT"
fdrive_acquire_lock "$CHECKOUT"
cd "$CHECKOUT"
fdrive_run_step 'Docker availability' docker info
fdrive_run_step 'development environment' pnpm dev:env
if [[ $WITH_INDEX -eq 1 ]]; then
  fdrive_run_step 'index development environment' docker compose -f deploy/compose.dev.yaml --profile index up -d
fi
fdrive_release_lock
LOG_ROOT="$CHECKOUT/.fdrive-workflow/logs"
[[ ! -L $LOG_ROOT ]] || fdrive_die "development log directory must not be a symlink: $LOG_ROOT"
mkdir -p "$LOG_ROOT"
LOG_DIR=$(mktemp -d "$LOG_ROOT/dev-app.XXXXXX") || fdrive_die 'cannot create development log directory'
set -m
env PORT="$API_PORT" pnpm --filter @fdrive/api dev >"$LOG_DIR/api.log" 2>&1 &
API_PID=$!
pnpm --filter @fdrive/web dev --port "$WEB_PORT" >"$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
if wait_for_http "http://127.0.0.1:$API_PORT/api/v1/health" 'API'; then
  :
else
  status=$?
  [[ $status -eq 130 || $status -eq 143 ]] && exit "$status"
  fdrive_die "API failed to become ready; see $LOG_DIR/api.log"
fi
if wait_for_http "http://127.0.0.1:$WEB_PORT" 'web app'; then
  :
else
  status=$?
  [[ $status -eq 130 || $status -eq 143 ]] && exit "$status"
  fdrive_die "web app failed to become ready; see $LOG_DIR/web.log"
fi
printf '%s: ready http://127.0.0.1:%s (API http://127.0.0.1:%s)\n' "$FDRIVE_COMMAND_NAME" "$WEB_PORT" "$API_PORT" >&2
while true; do
  [[ ${FDRIVE_SIGNAL_STATUS:-0} -eq 0 ]] || exit "$FDRIVE_SIGNAL_STATUS"
  if ! kill -0 "$API_PID" 2>/dev/null; then wait "$API_PID" || exit $?; exit 1; fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then wait "$WEB_PID" || exit $?; exit 1; fi
  sleep 1
done
