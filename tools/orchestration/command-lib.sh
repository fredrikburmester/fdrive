#!/bin/bash
# Shared implementation for the fdrive command helpers. Sourcing this file has no side effects.

fdrive_die() {
  printf '%s: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$*" >&2
  exit 1
}

fdrive_resolve_checkout() {
  local requested root
  [[ -d $1 ]] || {
    printf '%s: checkout is not a directory: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$1" >&2
    return 1
  }
  requested=$(cd "$1" && pwd -P) || return 1
  root=$(git -C "$requested" rev-parse --show-toplevel 2>/dev/null) || {
    printf '%s: checkout is not a Git repository: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$1" >&2
    return 1
  }
  root=$(cd "$root" && pwd -P) || return 1
  [[ $requested == "$root" ]] || {
    printf '%s: checkout must name the Git repository root: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$1" >&2
    return 1
  }
  printf '%s\n' "$root"
}

fdrive_resolve_executable() {
  local value directory resolved
  value=$1
  if [[ $value == */* ]]; then
    directory=$(dirname "$value")
    [[ -d $directory ]] || return 1
    directory=$(cd "$directory" && pwd -P) || return 1
    resolved="$directory/$(basename "$value")"
  else
    resolved=$(command -v "$value" 2>/dev/null) || return 1
  fi
  [[ -x $resolved ]] || return 1
  printf '%s\n' "$resolved"
}

fdrive_node_24_version() {
  local version
  version=$(cd / && "$1" --version 2>/dev/null) || return 1
  [[ $version =~ ^v24\.([0-9]+)\.([0-9]+)$ ]] || return 1
  printf '%s\n' "$version"
}

fdrive_node_is_24() {
  fdrive_node_24_version "$1" >/dev/null
}

fdrive_select_node() {
  local candidate resolved nvm_root version minor patch
  local best_node= best_minor=-1 best_patch=-1
  if [[ -n ${FDRIVE_NODE:-} ]]; then
    resolved=$(fdrive_resolve_executable "$FDRIVE_NODE") || {
      printf '%s: FDRIVE_NODE is not executable: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$FDRIVE_NODE" >&2
      return 1
    }
    fdrive_node_is_24 "$resolved" || {
      printf '%s: FDRIVE_NODE must run Node 24: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$resolved" >&2
      return 1
    }
    printf '%s\n' "$resolved"
    return 0
  fi

  resolved=$(fdrive_resolve_executable node 2>/dev/null || true)
  nvm_root=${NVM_DIR:-${HOME:-}/.nvm}
  for candidate in "$resolved" "$nvm_root"/versions/node/v24*/bin/node; do
    [[ -x $candidate ]] || continue
    version=$(fdrive_node_24_version "$candidate") || continue
    [[ $version =~ ^v24\.([0-9]+)\.([0-9]+)$ ]] || continue
    minor=${BASH_REMATCH[1]}
    patch=${BASH_REMATCH[2]}
    if [[ -z $best_node ]] || (( minor > best_minor || (minor == best_minor && patch > best_patch) )); then
      best_node=$candidate
      best_minor=$minor
      best_patch=$patch
    fi
  done

  if [[ -n $best_node ]]; then
    printf '%s\n' "$best_node"
    return 0
  fi

  printf '%s: Node 24 is required; set FDRIVE_NODE or install Node 24\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" >&2
  return 1
}

fdrive_required_pnpm_version() {
  local manifest version
  manifest=$1/package.json
  [[ -f $manifest ]] || {
    printf '%s: package.json is missing in %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$1" >&2
    return 1
  }
  version=$("$FDRIVE_SELECTED_NODE" -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).packageManager;
    const match = typeof value === "string" ? /^pnpm@(\d+\.\d+\.\d+)$/.exec(value) : null;
    if (match === null) process.exit(1);
    process.stdout.write(match[1]);
  ' "$manifest" 2>/dev/null) || {
      printf '%s: package.json must declare one packageManager pnpm version\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" >&2
      return 1
    }
  printf '%s\n' "$version"
}

fdrive_pnpm_version() {
  local node pnpm kind
  node=$1
  pnpm=$2
  kind=$3
  if [[ $kind == script ]]; then
    (cd / && "$node" "$pnpm" --version 2>/dev/null)
  else
    (cd / && "$pnpm" --version 2>/dev/null)
  fi
}

fdrive_check_pnpm_candidate() {
  local candidate expected kind version
  candidate=$1
  expected=$2
  kind=$3
  if [[ $kind == script ]]; then
    [[ -f $candidate && -r $candidate ]] || return 1
  else
    [[ -x $candidate ]] || return 1
  fi
  version=$(fdrive_pnpm_version "$FDRIVE_SELECTED_NODE" "$candidate" "$kind") || return 1
  [[ $version == "$expected" ]]
}

fdrive_select_pnpm() {
  local root expected candidate resolved kind path_candidate
  root=$1
  expected=$(fdrive_required_pnpm_version "$root") || return 1

  if [[ -n ${FDRIVE_PNPM:-} ]]; then
    kind=executable
    case "$FDRIVE_PNPM" in
      *.cjs|*.js)
        path_candidate=$FDRIVE_PNPM
        if [[ $path_candidate != /* ]]; then path_candidate="$PWD/$path_candidate"; fi
        candidate=$path_candidate
        kind=script
        ;;
      *)
        candidate=$(fdrive_resolve_executable "$FDRIVE_PNPM") || {
          printf '%s: FDRIVE_PNPM is not executable: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$FDRIVE_PNPM" >&2
          return 1
        }
        ;;
    esac
    fdrive_check_pnpm_candidate "$candidate" "$expected" "$kind" || {
      printf '%s: FDRIVE_PNPM must run pnpm %s: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$expected" "$candidate" >&2
      return 1
    }
    FDRIVE_SELECTED_PNPM=$candidate
    FDRIVE_SELECTED_PNPM_KIND=$kind
    return 0
  fi

  for candidate in \
    "${HOME:-}/Library/pnpm/.tools/pnpm/$expected/node_modules/pnpm/bin/pnpm.cjs" \
    "${HOME:-}/.local/share/pnpm/.tools/pnpm/$expected/node_modules/pnpm/bin/pnpm.cjs"; do
    if fdrive_check_pnpm_candidate "$candidate" "$expected" script; then
      FDRIVE_SELECTED_PNPM=$candidate
      FDRIVE_SELECTED_PNPM_KIND=script
      return 0
    fi
  done

  if resolved=$(command -v pnpm 2>/dev/null) && [[ -x $resolved ]] && fdrive_check_pnpm_candidate "$resolved" "$expected" executable; then
    FDRIVE_SELECTED_PNPM=$resolved
    FDRIVE_SELECTED_PNPM_KIND=executable
    return 0
  fi

  printf '%s: pnpm %s is required; set FDRIVE_PNPM to an installed matching pnpm\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$expected" >&2
  return 1
}

fdrive_prepare_runtime() {
  local root runtime_base
  root=$1
  FDRIVE_SELECTED_NODE=$(fdrive_select_node) || return 1
  runtime_base=${TMPDIR:-/tmp}
  FDRIVE_RUNTIME_DIR=$(mktemp -d "$runtime_base/fdrive-runtime.XXXXXX") || {
    printf '%s: cannot create temporary runtime directory\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" >&2
    return 1
  }
  printf '#!/bin/bash\nexec %q "$@"\n' "$FDRIVE_SELECTED_NODE" > "$FDRIVE_RUNTIME_DIR/node"
  chmod +x "$FDRIVE_RUNTIME_DIR/node"
  PATH="$FDRIVE_RUNTIME_DIR:$PATH"
  export PATH
  fdrive_select_pnpm "$root" || return 1
  if [[ $FDRIVE_SELECTED_PNPM_KIND == script ]]; then
    printf '#!/bin/bash\nexec %q %q "$@"\n' "$FDRIVE_SELECTED_NODE" "$FDRIVE_SELECTED_PNPM" > "$FDRIVE_RUNTIME_DIR/pnpm"
  else
    printf '#!/bin/bash\nexec %q "$@"\n' "$FDRIVE_SELECTED_PNPM" > "$FDRIVE_RUNTIME_DIR/pnpm"
  fi
  chmod +x "$FDRIVE_RUNTIME_DIR/pnpm"
}

fdrive_cleanup_runtime() {
  [[ -n ${FDRIVE_RUNTIME_DIR:-} && -d $FDRIVE_RUNTIME_DIR ]] || return 0
  rm -f "$FDRIVE_RUNTIME_DIR/node" "$FDRIVE_RUNTIME_DIR/pnpm"
  rmdir "$FDRIVE_RUNTIME_DIR" 2>/dev/null || true
  FDRIVE_RUNTIME_DIR=
}

fdrive_acquire_lock() {
  local root state_path lock_path owner
  root=$1
  state_path="$root/.fdrive-workflow"
  lock_path="$state_path/command.lock"
  if [[ -L $state_path ]]; then
    printf '%s: workflow state directory must not be a symlink: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$state_path" >&2
    return 1
  fi
  if [[ ! -d $state_path ]]; then
    if ! mkdir "$state_path" 2>/dev/null && [[ ! -d $state_path || -L $state_path ]]; then
      printf '%s: cannot create workflow state directory: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$state_path" >&2
      return 1
    fi
  fi
  if [[ -L $lock_path ]]; then
    printf '%s: checkout operation lock must not be a symlink: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$lock_path" >&2
    return 1
  fi
  if ! mkdir "$lock_path" 2>/dev/null; then
    if [[ -d $lock_path && ! -L $lock_path ]]; then
      owner=$(sed -n '1p' "$lock_path/owner" 2>/dev/null || true)
      printf '%s: checkout operation lock is held at %s%s\n' \
        "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$lock_path" "${owner:+ ($owner)}" >&2
      return 75
    fi
    printf '%s: cannot create checkout operation lock: %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$lock_path" >&2
    return 1
  fi
  FDRIVE_LOCK_STATE_PATH=$state_path
  FDRIVE_LOCK_PATH=$lock_path
  FDRIVE_LOCK_TOKEN="$$:${RANDOM:-0}"
  printf '%s\n' "$FDRIVE_LOCK_TOKEN" > "$lock_path/token"
  printf 'pid %s checkout %s\n' "$$" "$root" > "$lock_path/owner"
}

fdrive_release_lock() {
  local token
  [[ -n ${FDRIVE_LOCK_PATH:-} && -d $FDRIVE_LOCK_PATH ]] || return 0
  [[ ! -L ${FDRIVE_LOCK_STATE_PATH:-} && ! -L $FDRIVE_LOCK_PATH ]] || return 0
  token=$(sed -n '1p' "$FDRIVE_LOCK_PATH/token" 2>/dev/null || true)
  if [[ $token == "${FDRIVE_LOCK_TOKEN:-}" && -n $token ]]; then
    rm -f "$FDRIVE_LOCK_PATH/owner" "$FDRIVE_LOCK_PATH/token"
    rmdir "$FDRIVE_LOCK_PATH" 2>/dev/null || true
  fi
  FDRIVE_LOCK_STATE_PATH=
  FDRIVE_LOCK_PATH=
  FDRIVE_LOCK_TOKEN=
}

fdrive_run_step() {
  local label status
  label=$1
  shift
  printf '%s: start %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$label" >&2
  if fdrive_run_child "$@"; then
    status=0
  else
    status=$?
  fi
  printf '%s: end %s status %s\n' "${FDRIVE_COMMAND_NAME:-fdrive-command}" "$label" "$status" >&2
  return "$status"
}

fdrive_workspace_has_package() {
  "$FDRIVE_SELECTED_NODE" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, requested] = process.argv.slice(1);
    for (const parent of ["apps", "packages"]) {
      const directory = path.join(root, parent);
      if (!fs.existsSync(directory)) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = path.join(directory, entry.name, "package.json");
        if (!fs.existsSync(manifest)) continue;
        if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === requested) process.exit(0);
      }
    }
    process.exit(1);
  ' "$1" "$2"
}

fdrive_handle_signal() {
  local signal status
  signal=$1
  status=$2
  FDRIVE_SIGNAL_STATUS=$status
  if [[ -n ${FDRIVE_CHILD_PID:-} ]]; then
    if [[ ${FDRIVE_CHILD_GROUP:-0} -eq 1 ]]; then
      kill -s "$signal" -- "-$FDRIVE_CHILD_PID" 2>/dev/null || true
    else
      kill -s "$signal" "$FDRIVE_CHILD_PID" 2>/dev/null || true
    fi
  fi
}

fdrive_wait_for_child() {
  local status
  while true; do
    if wait "$FDRIVE_CHILD_PID"; then status=0; else status=$?; fi
    kill -0 "$FDRIVE_CHILD_PID" 2>/dev/null || break
  done
  FDRIVE_CHILD_PID=
  if [[ ${FDRIVE_CHILD_GROUP:-0} -eq 1 ]]; then set +m; fi
  FDRIVE_CHILD_GROUP=0
  if [[ ${FDRIVE_SIGNAL_STATUS:-0} -ne 0 && $status -eq 0 ]]; then return "$FDRIVE_SIGNAL_STATUS"; fi
  return "$status"
}

fdrive_run_child() {
  [[ ${FDRIVE_SIGNAL_STATUS:-0} -eq 0 ]] || return "$FDRIVE_SIGNAL_STATUS"
  FDRIVE_CHILD_GROUP=0
  if [[ ! -t 0 ]]; then
    set -m
    FDRIVE_CHILD_GROUP=1
  fi
  "$@" <&0 &
  FDRIVE_CHILD_PID=$!
  fdrive_wait_for_child
}
