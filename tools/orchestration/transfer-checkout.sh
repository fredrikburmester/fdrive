#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

usage() {
  printf 'usage: ALLOWED="<regex>" bash transfer-checkout.sh [--check] <source-checkout> <target-checkout>\n'
  printf '       ALLOWED="<regex>" bash transfer-checkout.sh --diff <source-checkout>\n'
}

if [[ ${1:-} == --help && $# -eq 1 ]]; then usage; exit 0; fi
if [[ ${1:-} == --diff ]]; then
  shift
  [[ $# -eq 1 ]] || { usage >&2; exit 1; }
  [[ -n ${ALLOWED:-} ]] || { printf 'transfer-checkout: ALLOWED must be a nonempty path-prefix regex\n' >&2; exit 1; }
  exec python3 "$SCRIPT_DIR/transfer-checkout.py" diff --allowed "$ALLOWED" "$1"
fi
CHECK=0
if [[ ${1:-} == --check ]]; then CHECK=1; shift; fi
[[ $# -eq 2 ]] || { usage >&2; exit 1; }
[[ -n ${ALLOWED:-} ]] || { printf 'transfer-checkout: ALLOWED must be a nonempty path-prefix regex\n' >&2; exit 1; }
SCOPE="^(${ALLOWED})"
if [[ '' =~ $SCOPE ]]; then
  :
else
  [[ $? -eq 1 ]] || { printf 'transfer-checkout: ALLOWED is not a valid extended regular expression\n' >&2; exit 1; }
fi
if [[ $CHECK -eq 1 ]]; then
  exec python3 "$SCRIPT_DIR/transfer-checkout.py" transfer --allowed "$ALLOWED" --check "$1" "$2"
fi
exec python3 "$SCRIPT_DIR/transfer-checkout.py" transfer --allowed "$ALLOWED" "$1" "$2"
