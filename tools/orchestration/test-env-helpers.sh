#!/bin/bash
# Regression tests for environment helpers. Uses disposable repositories and fake tools only.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
HELPERS_DIR=${FDRIVE_HELPERS_DIR:-$SCRIPT_DIR}
SETUP_PYTHON="$HELPERS_DIR/setup-python.sh"
DEV_APP="$HELPERS_DIR/dev-app.sh"
for HELPER in "$SETUP_PYTHON" "$DEV_APP"; do
  [[ -f $HELPER ]] || { printf 'missing helper: %s\n' "$HELPER" >&2; exit 1; }
done

TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fdrive-env-helper-test.XXXXXX")
TEST_ROOT=$(cd "$TEST_ROOT" && pwd -P)
OUT="$TEST_ROOT/stdout"
ERR="$TEST_ROOT/stderr"
LOG="$TEST_ROOT/tools.log"
BACKGROUND_PID=
cleanup() {
  [[ -z $BACKGROUND_PID ]] || kill -TERM "$BACKGROUND_PID" 2>/dev/null || true
  [[ -z $BACKGROUND_PID ]] || wait "$BACKGROUND_PID" 2>/dev/null || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='Environment Helper Test' GIT_AUTHOR_EMAIL='environment@example.invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

find_node24() {
  local candidate version
  candidate=$(command -v node 2>/dev/null || true)
  if [[ -n $candidate ]]; then
    version=$("$candidate" --version 2>/dev/null || true)
    [[ $version == v24.* ]] && { printf '%s\n' "$candidate"; return 0; }
  fi
  for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v24*/bin/node; do
    [[ -x $candidate ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

NODE24=$(find_node24) || { printf 'Node 24 fixture runtime unavailable\n' >&2; exit 1; }
BIN="$TEST_ROOT/bin"
mkdir "$BIN"
export PATH="$BIN:$PATH" LOG

capture() {
  set +e
  "$@" >"$OUT" 2>"$ERR"
  STATUS=$?
  set -e
}

expect_success() {
  capture "$@"
  [[ $STATUS -eq 0 ]] || { sed -n '1,120p' "$ERR" >&2; exit 1; }
}

expect_failure() {
  capture "$@"
  [[ $STATUS -ne 0 ]] || { printf 'unexpected success: %s\n' "$*" >&2; exit 1; }
}

assert_contains() { grep -F -- "$2" "$1" >/dev/null || { printf 'missing %s\n' "$2" >&2; exit 1; }; }
assert_missing() { [[ ! -e $1 ]] || { printf 'unexpected path: %s\n' "$1" >&2; exit 1; }; }

write_repo() {
  ROOT="$TEST_ROOT/repo-$1"
  mkdir -p "$ROOT/services/indexer" "$ROOT/services/ocr" "$ROOT/services/image-embed"
  printf '[project]\nname = "fixture"\n' > "$ROOT/services/indexer/pyproject.toml"
  printf '[project]\nname = "fixture"\n' > "$ROOT/services/ocr/pyproject.toml"
  printf '[project]\nname = "fixture"\n' > "$ROOT/services/image-embed/pyproject.toml"
  printf '{"name":"fixture","private":true,"packageManager":"pnpm@10.11.0"}\n' > "$ROOT/package.json"
  git init -q "$ROOT"
  git -C "$ROOT" checkout -qb fixture
  git -C "$ROOT" add -A
  git -C "$ROOT" commit -qm base
}

FAKE_PYTHON="$BIN/python3.12"
cat > "$FAKE_PYTHON" <<'PYTHON'
#!/bin/bash
set -euo pipefail
if [[ ${1:-} == -c && ${2:-} == *sys.prefix* ]]; then exit "${FAKE_SYSTEM_PREFIX_STATUS:-1}"; fi
if [[ ${1:-} == -c ]]; then printf '%s\n' "${FAKE_PYTHON_VERSION:-3 12 1}"; exit 0; fi
if [[ ${1:-} == -m && ${2:-} == venv ]]; then
  mkdir -p "$3/bin"
cat > "$3/bin/python" <<'INNER'
#!/bin/bash
set -euo pipefail
if [[ ${1:-} == -c && ${2:-} == *sys.prefix* ]]; then exit "${FAKE_VENV_PREFIX_STATUS:-0}"; fi
if [[ ${1:-} == -c ]]; then printf '3 12 1\n'; exit 0; fi
printf 'venv-python' >> "$LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$LOG"; done
printf ' PWD=<%s>\n' "$PWD" >> "$LOG"
if [[ ${1:-} == -m && ${2:-} == pip ]]; then exit "${FAKE_PIP_STATUS:-0}"; fi
INNER
  chmod +x "$3/bin/python"
  printf 'venv <%s> PWD=<%s>\n' "$3" "$PWD" >> "$LOG"
  exit 0
fi
exit 91
PYTHON
chmod +x "$FAKE_PYTHON"

FAKE_PNPM="$BIN/pnpm"
cat > "$FAKE_PNPM" <<'PNPM'
#!/bin/bash
set -euo pipefail
if [[ ${1:-} == --version ]]; then printf '10.11.0\n'; exit 0; fi
printf 'pnpm' >> "$LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$LOG"; done
printf ' PWD=<%s>\n' "$PWD" >> "$LOG"
if [[ $* == 'dev:env' || $* == *'compose -f deploy/compose.dev.yaml --profile index up -d'* ]]; then exit 0; fi
if [[ $* == *'@fdrive/api dev'* || $* == *'@fdrive/web dev'* ]]; then
  if [[ $* == *'@fdrive/api dev'* ]]; then server=api; else server=web; fi
  printf 'server-start <%s>\n' "$server" >> "$LOG"
  if [[ ${EARLY_SERVER:-} == "$server" ]]; then exit 0; fi
  trap 'printf "server-term <%s>\\n" "$server" >> "$LOG"; exit 0' TERM INT
  while true; do sleep 1; done
fi
exit 0
PNPM
chmod +x "$FAKE_PNPM"

cat > "$BIN/docker" <<'DOCKER'
#!/bin/bash
set -euo pipefail
printf 'docker' >> "$LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$LOG"; done
printf '\n' >> "$LOG"
exit 0
DOCKER
chmod +x "$BIN/docker"

cat > "$BIN/lsof" <<'LSOF'
#!/bin/bash
set -euo pipefail
case "$*" in *":${OCCUPIED_PORT:-0}"*) [[ -n ${OCCUPIED_PORT:-} ]] && exit 0;; esac
exit 1
LSOF
chmod +x "$BIN/lsof"

cat > "$BIN/curl" <<'CURL'
#!/bin/bash
set -euo pipefail
exit "${FAKE_CURL_STATUS:-0}"
CURL
chmod +x "$BIN/curl"

write_repo python
expect_success env FDRIVE_PYTHON="$FAKE_PYTHON" bash "$SETUP_PYTHON" "$ROOT" indexer
assert_contains "$LOG" 'venv <.venv>'
assert_contains "$LOG" 'venv-python <-m> <pip> <install> <-e> <.[dev]>'
[[ -d $ROOT/services/indexer/.venv ]] || { printf 'venv missing\n' >&2; exit 1; }
printf '' > "$LOG"
expect_success env FDRIVE_PYTHON="$FAKE_PYTHON" FAKE_PYTHON_VERSION='3 11 9' bash "$SETUP_PYTHON" "$ROOT" indexer
assert_missing "$ROOT/services/indexer/.venv/.unexpected"
assert_contains "$LOG" 'venv-python <-m> <pip> <install> <-e> <.[dev]>'
if grep -F 'venv <.venv>' "$LOG" >/dev/null; then printf 'existing venv was recreated\n' >&2; exit 1; fi
printf 'PASS setup creates locked editable service venv\n'

expect_failure env FDRIVE_PYTHON="$FAKE_PYTHON" FAKE_PYTHON_VERSION='3 11 9' bash "$SETUP_PYTHON" "$ROOT" ocr
assert_missing "$ROOT/services/ocr/.venv"
mkdir -p "$ROOT/.fdrive-workflow/command.lock"
expect_failure env FDRIVE_PYTHON="$FAKE_PYTHON" bash "$SETUP_PYTHON" "$ROOT" image-embed
assert_missing "$ROOT/services/image-embed/.venv"
rmdir "$ROOT/.fdrive-workflow/command.lock"
mkdir "$TEST_ROOT/external-venv"
ln -s "$TEST_ROOT/external-venv" "$ROOT/services/image-embed/.venv"
expect_failure env FDRIVE_PYTHON="$FAKE_PYTHON" bash "$SETUP_PYTHON" "$ROOT" image-embed
printf 'PASS setup rejects unsupported Python and a held checkout lock\n'

write_repo pip
capture env FDRIVE_PYTHON="$FAKE_PYTHON" FAKE_PIP_STATUS=47 bash "$SETUP_PYTHON" "$ROOT" ocr
[[ $STATUS -eq 47 ]] || { printf 'pip status lost: %s\n' "$STATUS" >&2; exit 1; }
assert_missing "$ROOT/.fdrive-workflow/command.lock"
: > "$LOG"
mkdir -p "$ROOT/services/image-embed/.venv"
ln -s "$FAKE_PYTHON" "$ROOT/services/image-embed/.venv/bin"
expect_failure env FDRIVE_PYTHON="$FAKE_PYTHON" bash "$SETUP_PYTHON" "$ROOT" image-embed
[[ ! -s $LOG ]] || { printf 'malformed venv ran pip\n' >&2; exit 1; }
printf 'PASS setup preserves pip failures, unlocks, and rejects malformed venvs\n'

write_repo dev
set +e
env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FDRIVE_PYTHON="$FAKE_PYTHON" \
  bash "$DEV_APP" "$ROOT" --web-port 32123 --index >"$OUT" 2>"$ERR" &
BACKGROUND_PID=$!
set -e
for attempt in 1 2 3 4 5; do
  grep -F 'ready http://127.0.0.1:32123' "$ERR" >/dev/null && break
  sleep 1
done
assert_contains "$ERR" 'ready http://127.0.0.1:32123'
kill -TERM "$BACKGROUND_PID"
set +e
wait "$BACKGROUND_PID"
STATUS=$?
set -e
BACKGROUND_PID=
[[ $STATUS -ne 0 ]] || { printf 'dev helper ignored termination\n' >&2; exit 1; }
assert_contains "$LOG" 'docker <info>'
assert_contains "$LOG" 'pnpm <dev:env>'
assert_contains "$LOG" 'pnpm <--filter> <@fdrive/api> <dev>'
assert_contains "$LOG" 'pnpm <--filter> <@fdrive/web> <dev> <--port> <32123>'
assert_contains "$LOG" 'server-term'
printf 'PASS dev starts prerequisites, waits for readiness, and cleans owned servers\n'

write_repo readiness
: > "$LOG"
expect_failure env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_CURL_STATUS=1 \
  FDRIVE_DEV_READY_TIMEOUT_SECONDS=1 bash "$DEV_APP" "$ROOT" --web-port 32124
assert_contains "$LOG" 'server-term <api>'
assert_contains "$LOG" 'server-term <web>'
printf 'PASS dev readiness failure cleans both server groups\n'

write_repo early
: > "$LOG"
capture env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" EARLY_SERVER=api bash "$DEV_APP" "$ROOT" --web-port 32125
[[ $STATUS -eq 1 ]] || { printf 'early clean exit status: %s\n' "$STATUS" >&2; exit 1; }
assert_contains "$LOG" 'server-term <web>'
printf 'PASS dev treats an early zero exit as failure\n'

write_repo interrupt
: > "$LOG"
env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" FAKE_CURL_STATUS=1 \
  FDRIVE_DEV_READY_TIMEOUT_SECONDS=30 bash "$DEV_APP" "$ROOT" --web-port 32126 >"$OUT" 2>"$ERR" &
BACKGROUND_PID=$!
sleep 1
kill -TERM "$BACKGROUND_PID"
set +e
wait "$BACKGROUND_PID"
STATUS=$?
set -e
BACKGROUND_PID=
[[ $STATUS -eq 143 ]] || { printf 'readiness interrupt status: %s\n' "$STATUS" >&2; exit 1; }
assert_contains "$LOG" 'server-term <api>'
assert_contains "$LOG" 'server-term <web>'
printf 'PASS dev propagates interrupts during readiness\n'

write_repo occupied
: > "$LOG"
expect_failure env FDRIVE_NODE="$NODE24" FDRIVE_PNPM="$FAKE_PNPM" OCCUPIED_PORT=3001 bash "$DEV_APP" "$ROOT"
assert_contains "$ERR" 'port is already in use: 3001'
[[ ! -s $LOG ]] || { printf 'occupied port started prerequisites\n' >&2; exit 1; }
printf 'PASS dev refuses occupied API ports\n'
printf '8 environment helper regression groups passed.\n'
