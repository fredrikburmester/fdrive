#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=command-lib.sh
source "$SCRIPT_DIR/command-lib.sh"
FDRIVE_COMMAND_NAME=setup-checkout
FDRIVE_RUNTIME_DIR=
FDRIVE_LOCK_STATE_PATH=
FDRIVE_LOCK_PATH=
FDRIVE_LOCK_TOKEN=
FDRIVE_CHILD_PID=
FDRIVE_CHILD_GROUP=0
FDRIVE_SIGNAL_STATUS=0

usage() {
  printf 'usage: bash setup-checkout.sh <checkout>\n'
}

if [[ ${1:-} == --help && $# -eq 1 ]]; then usage; exit 0; fi
[[ $# -eq 1 ]] || { usage >&2; exit 1; }
CHECKOUT=$(fdrive_resolve_checkout "$1") || exit $?

finish() {
  local status=$?
  trap - EXIT INT TERM
  fdrive_release_lock
  fdrive_cleanup_runtime
  printf '%s: end status %s\n' "$FDRIVE_COMMAND_NAME" "$status" >&2
  exit "$status"
}

declared_migration_output() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const manifestPath = path.join(root, "packages/db/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const target = manifest.bin && manifest.bin["fdrive-migrate"];
    if (typeof target !== "string" || target.length === 0) process.exit(1);
    process.stdout.write(path.resolve(path.dirname(manifestPath), target));
  ' "$CHECKOUT"
}

verify_migration_link() {
  local output candidate found
  output=$(declared_migration_output) || {
    printf '%s: @fdrive/db must declare the fdrive-migrate binary\n' "$FDRIVE_COMMAND_NAME" >&2
    return 1
  }
  [[ -f $output ]] || {
    printf '%s: declared fdrive-migrate output is missing: %s\n' "$FDRIVE_COMMAND_NAME" "$output" >&2
    return 1
  }
  found=0
  for candidate in \
    "$CHECKOUT/apps/api/node_modules/.bin/fdrive-migrate" \
    "$CHECKOUT/node_modules/.bin/fdrive-migrate"; do
    if [[ -f $candidate && -x $candidate ]]; then found=1; break; fi
  done
  [[ $found -eq 1 ]] || {
    printf '%s: no executable linked fdrive-migrate shim found in apps/api or root node_modules/.bin\n' "$FDRIVE_COMMAND_NAME" >&2
    return 1
  }
}

read_installed_store() {
  node -e '
    const fs = require("node:fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/);
    const matches = lines.filter((line) => /^storeDir:/.test(line));
    if (matches.length !== 1) process.exit(1);
    const raw = matches[0].slice("storeDir:".length).trim();
    const apostrophe = String.fromCharCode(39);
    let value;
    try {
      if (raw.startsWith("\"")) value = JSON.parse(raw);
      else if (raw.startsWith(apostrophe) && raw.endsWith(apostrophe) && raw.length >= 2) {
        value = raw.slice(1, -1).split(apostrophe + apostrophe).join(apostrophe);
      } else if (raw.startsWith(apostrophe)) process.exit(1);
      else value = raw;
    } catch {
      process.exit(1);
    }
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) process.exit(1);
    process.stdout.write(value);
  ' "$1"
}

normalize_store_path() {
  if [[ -d $1 ]]; then
    (cd "$1" && pwd -P)
  else
    printf '%s\n' "$1"
  fi
}

verify_install_store() {
  local modules_file configured_store installed_store
  configured_store=$(pnpm store path) || return $?
  [[ -n $configured_store && $configured_store != *$'\n'* ]] || {
    printf '%s: selected pnpm returned an invalid store path\n' "$FDRIVE_COMMAND_NAME" >&2
    return 1
  }
  configured_store=$(normalize_store_path "$configured_store") || return 1
  [[ -d $CHECKOUT/node_modules ]] || return 0
  modules_file="$CHECKOUT/node_modules/.modules.yaml"
  [[ -f $modules_file ]] || {
    printf '%s: existing node_modules lacks .modules.yaml; remove or repair it before setup\n' "$FDRIVE_COMMAND_NAME" >&2
    return 1
  }
  installed_store=$(read_installed_store "$modules_file") || {
    printf '%s: existing node_modules has no single storeDir; remove or repair it before setup\n' "$FDRIVE_COMMAND_NAME" >&2
    return 1
  }
  installed_store=$(normalize_store_path "$installed_store") || return 1
  [[ $installed_store == "$configured_store" ]] || {
    printf '%s: existing node_modules uses pnpm store %s, selected pnpm uses %s; reconcile the store before setup\n' \
      "$FDRIVE_COMMAND_NAME" "$installed_store" "$configured_store" >&2
    return 1
  }
}

trap finish EXIT
trap 'fdrive_handle_signal INT 130' INT
trap 'fdrive_handle_signal TERM 143' TERM
printf '%s: start checkout %s\n' "$FDRIVE_COMMAND_NAME" "$CHECKOUT" >&2
fdrive_prepare_runtime "$CHECKOUT"
fdrive_acquire_lock "$CHECKOUT"
cd "$CHECKOUT"
fdrive_run_step 'pnpm store preflight' verify_install_store
fdrive_run_step 'frozen install' env CI=true pnpm install --frozen-lockfile
fdrive_run_step '@fdrive/db build' pnpm --filter '@fdrive/db...' run build
fdrive_run_step 'frozen relink install' env CI=true pnpm install --frozen-lockfile
fdrive_run_step 'fdrive-migrate verification' verify_migration_link
