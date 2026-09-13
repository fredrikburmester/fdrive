#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
python3 -m unittest discover -s "$ROOT/tools/macos" -p 'test_*.py'
