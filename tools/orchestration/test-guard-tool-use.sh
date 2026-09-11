#!/bin/bash
# Standalone regression tests for the PreToolUse guard. No Git or filesystem mutation.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
GUARD="$SCRIPT_DIR/guard-tool-use.sh"
PASSES=0
fail() { printf 'test-guard-tool-use: %s\n' "$1" >&2; exit 1; }
pass() { PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$1"; }

payload() {
  python3 -c '
import json, sys
print(json.dumps({"hook_event_name": "PreToolUse", "tool_name": sys.argv[1],
                  "tool_input": json.loads(sys.argv[2])}))
' "$1" "$2"
}

run_guard() {
  local status=0
  GUARD_OUTPUT=$(payload "$1" "$2" | bash "$GUARD") || status=$?
  GUARD_STATUS=$status
}

expect_blocked() {
  run_guard "$1" "$2"
  [[ $GUARD_STATUS -eq 2 ]] || fail "expected block (exit 2), got $GUARD_STATUS for: $3"
  printf '%s' "$GUARD_OUTPUT" | grep -q '"permissionDecision": "deny"' \
    || fail "block emitted no deny decision for: $3"
}

expect_allowed() {
  run_guard "$1" "$2"
  [[ $GUARD_STATUS -eq 0 ]] || fail "expected allow (exit 0), got $GUARD_STATUS for: $3"
  [[ -z $GUARD_OUTPUT ]] || fail "allow emitted output for: $3"
}

bash_input() { python3 -c 'import json,sys; print(json.dumps({"command": sys.argv[1]}))' "$1"; }
path_input() { python3 -c 'import json,sys; print(json.dumps({"file_path": sys.argv[1]}))' "$1"; }

for command in \
  'git stash' \
  'git stash pop' \
  'git stash clear' \
  'git stash apply' \
  'git -C /tmp/checkout stash' \
  'cd /tmp && git stash' \
  'FOO=bar git stash' \
  'git reset --hard HEAD~1' \
  'git clean -fd' \
  'git clean -fdx' \
  'git push --force origin main' \
  'git push -f'; do
  expect_blocked Bash "$(bash_input "$command")" "$command"
done
pass 'unsafe Git state mutations blocked, including compound and prefixed forms'

for command in \
  'git stash list' \
  'git stash push -m p10-wip' \
  'git stash apply 0a1b2c3' \
  'git stash drop 0a1b2c3' \
  'git status' \
  'git commit -m "feat: x"' \
  'git merge --no-ff claude/chunk' \
  'git clean -n' \
  'git push --force-with-lease' \
  'git reset HEAD~1' \
  'grep -rn "git stash" WORKING.md' \
  'bash tools/orchestration/verify.sh "$PWD" application'; do
  expect_allowed Bash "$(bash_input "$command")" "$command"
done
pass 'legitimate Git and helper commands untouched, including the tagged stash fallback'

tick=$(printf '\140')
expect_allowed Bash "$(bash_input "git commit -m 'docs: explain why ${tick}git stash${tick} is unsafe'")" 'backticked prose'
expect_allowed Bash "$(bash_input "printf '%s' 'see ${tick}git reset --hard${tick} in the guard' > /dev/null")" 'backticked prose in a write'
pass 'commands quoted in prose are not treated as command substitution'

expect_blocked Bash "$(bash_input 'gh pr comment 1 --body "https://claude.ai/code/session_abc"')" 'session link'
expect_allowed Bash "$(bash_input 'gh pr comment 1 --body "see the plan doc"')" 'ordinary pr comment'
pass 'session links refused'

expect_blocked Edit "$(path_input "$SCRIPT_DIR/../../pnpm-lock.yaml")" 'lockfile edit'
expect_blocked Write "$(path_input 'pnpm-lock.yaml')" 'lockfile write'
expect_allowed Edit "$(path_input 'apps/api/src/auth/service.ts')" 'ordinary source edit'
pass 'lockfile hand-edits refused'

expect_allowed Read "$(path_input 'pnpm-lock.yaml')" 'reading the lockfile'
run_guard Bash '{"command": 123}'
[[ $GUARD_STATUS -eq 0 ]] || fail 'non-string command should not block'
printf 'not json' | bash "$GUARD" >/dev/null || fail 'malformed payload must not block'
pass 'guard fails open on unrelated tools and malformed input'

# Codex names its tools differently; dispatch must fall back to the payload shape.
expect_blocked shell "$(bash_input 'git reset --hard HEAD~1')" 'unnamed shell tool'
expect_allowed shell "$(bash_input 'git status')" 'unnamed shell tool, ordinary command'
write_input() {
  python3 -c 'import json,sys; print(json.dumps({"path": sys.argv[1], "content": "x"}))' "$1"
}
expect_blocked apply_patch "$(write_input 'pnpm-lock.yaml')" 'unnamed edit tool on the lockfile'
expect_allowed apply_patch "$(write_input 'apps/api/src/app.ts')" 'unnamed edit tool on a source file'
expect_allowed read_file "$(path_input 'pnpm-lock.yaml')" 'path without content is not an edit'
pass 'payload-shape dispatch covers tools this guard does not know by name'

printf '%s guard regression groups passed.\n' "$PASSES"
