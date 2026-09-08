#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=command-lib.sh
source "$SCRIPT_DIR/command-lib.sh"
FDRIVE_COMMAND_NAME=verify
FDRIVE_RUNTIME_DIR=
FDRIVE_LOCK_STATE_PATH=
FDRIVE_LOCK_PATH=
FDRIVE_LOCK_TOKEN=
FDRIVE_CHILD_PID=
FDRIVE_CHILD_GROUP=0
FDRIVE_SIGNAL_STATUS=0

usage() {
  printf '%s\n' \
    'usage: bash verify.sh <checkout> workflow' \
    '       bash verify.sh <checkout> package <@fdrive/name>' \
    '       bash verify.sh <checkout> application' \
    '       bash verify.sh <checkout> integration' \
    '       bash verify.sh <checkout> browser [Playwright args...]' \
    '       bash verify.sh <checkout> python <indexer|ocr|image-embed>'
}

if [[ ${1:-} == --help && $# -eq 1 ]]; then usage; exit 0; fi
[[ $# -ge 2 ]] || { usage >&2; exit 1; }
CHECKOUT_ARG=$1
PROFILE=$2
shift 2

case "$PROFILE" in
  workflow|application|integration)
    [[ $# -eq 0 ]] || { usage >&2; exit 1; }
    ;;
  package)
    [[ $# -eq 1 && $1 =~ ^@fdrive/[a-z0-9][a-z0-9_-]*$ ]] || { usage >&2; exit 1; }
    PACKAGE=$1
    ;;
  browser)
    ;;
  python)
    [[ $# -eq 1 ]] || { usage >&2; exit 1; }
    SERVICE=$1
    case "$SERVICE" in indexer|ocr|image-embed) ;; *) usage >&2; exit 1 ;; esac
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

CHECKOUT=$(fdrive_resolve_checkout "$CHECKOUT_ARG") || exit $?

finish() {
  local status=$?
  trap - EXIT INT TERM
  fdrive_release_lock
  fdrive_cleanup_runtime
  printf '%s: end profile %s status %s\n' "$FDRIVE_COMMAND_NAME" "$PROFILE" "$status" >&2
  exit "$status"
}

workflow_shell_syntax() {
  local script
  while IFS= read -r -d '' script; do
    bash -n "$script" || return $?
  done < <(find "$CHECKOUT/tools/orchestration" -maxdepth 1 -type f -name '*.sh' -print0)
}

workflow_toml() {
  python3 -c '
import pathlib
import sys
if sys.version_info < (3, 11):
    raise SystemExit("Python 3.11 or newer is required for tomllib")
import tomllib
for path in pathlib.Path(".codex").rglob("*.toml"):
    tomllib.loads(path.read_text())
'
}

verify_workflow() {
  fdrive_run_step 'orchestration shell syntax' workflow_shell_syntax
  fdrive_run_step 'Codex TOML parsing' workflow_toml
  fdrive_run_step 'orchestration regression tests' bash tools/orchestration/test-orchestration.sh
  fdrive_run_step 'command helper regression tests' bash tools/orchestration/test-command-helpers.sh
  fdrive_run_step 'agy worker regression tests' python3 tools/orchestration/test_agy_worker.py
  fdrive_run_step 'lint' pnpm lint
  fdrive_run_step 'diff check' git diff --check
}

verify_package() {
  fdrive_run_step 'lint' pnpm lint
  fdrive_run_step "$PACKAGE typecheck" pnpm --filter "$PACKAGE" typecheck
  fdrive_run_step "$PACKAGE coverage" pnpm --filter "$PACKAGE" test:coverage
}

verify_application() {
  fdrive_run_step 'lint' pnpm lint
  fdrive_run_step 'typecheck' pnpm typecheck
  fdrive_run_step 'coverage' pnpm test:coverage
}

verify_integration() {
  fdrive_run_step 'integration tests' pnpm test:integration
}

verify_browser() {
  fdrive_run_step 'browser tests' pnpm --filter @fdrive/web test:e2e "$@"
}

verify_python() {
  local service_dir module
  local -a source_paths
  service_dir="$CHECKOUT/services/$SERVICE"
  case "$SERVICE" in
    indexer) module=fdrive_indexer ;;
    ocr) module=fdrive_ocr ;;
    image-embed) module=fdrive_image_embed ;;
  esac
  [[ -d $service_dir ]] || fdrive_die "service directory is missing: $service_dir"
  source_paths=(src tests)
  [[ -d $service_dir/scripts ]] && source_paths+=(scripts)
  cd "$service_dir"
  fdrive_run_step "$SERVICE ruff" .venv/bin/ruff check "${source_paths[@]}"
  source_paths=(src)
  [[ -d scripts ]] && source_paths+=(scripts)
  fdrive_run_step "$SERVICE mypy" .venv/bin/mypy "${source_paths[@]}"
  fdrive_run_step "$SERVICE coverage" .venv/bin/pytest -q "--cov=$module" --cov-report=term-missing --cov-fail-under=95
  if [[ $SERVICE == indexer ]]; then
    fdrive_run_step 'indexer Linux inotify tests' bash scripts/test-in-docker.sh
  fi
}

trap finish EXIT
trap 'fdrive_handle_signal INT 130' INT
trap 'fdrive_handle_signal TERM 143' TERM
printf '%s: start profile %s checkout %s\n' "$FDRIVE_COMMAND_NAME" "$PROFILE" "$CHECKOUT" >&2
if [[ $PROFILE != python ]]; then fdrive_prepare_runtime "$CHECKOUT"; fi
if [[ $PROFILE == package ]] && ! fdrive_workspace_has_package "$CHECKOUT" "$PACKAGE"; then
  fdrive_die "unknown workspace package: $PACKAGE"
fi
fdrive_acquire_lock "$CHECKOUT"
cd "$CHECKOUT"
case "$PROFILE" in
  workflow) verify_workflow ;;
  package) verify_package ;;
  application) verify_application ;;
  integration) verify_integration ;;
  browser) verify_browser "$@" ;;
  python) verify_python ;;
esac
