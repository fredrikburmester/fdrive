---
name: fdrive-verify
description: Run an fdrive verification profile in the current checkout. Use whenever WORKING.md's verification matrix calls for a profile check, instead of composing a verify.sh command by hand.
argument-hint: workflow | application | integration | package <@fdrive/name> | browser [spec] | python <indexer|ocr|image-embed|runtime>
---

Verification ran in the current checkout. Results follow.

| Profile | Checks and prerequisites |
| --- | --- |
| `workflow` | Shell/Python syntax, agent definitions, helper regressions, lint, diff check |
| `package @fdrive/<name>` | Repository lint, named package typecheck and coverage |
| `application` | Repository lint, typecheck, coverage |
| `integration` | Container integration tests; needs Docker |
| `browser [spec]` | Playwright tests; needs Docker and Chromium; omit the spec for the full suite |
| `python <service>` | Service ruff/mypy/coverage; indexer also runs Docker inotify tests |

Profiles stop at the first failed gate. Failure output below is a bounded excerpt: read the
named log for detail rather than rerunning to see more. A skipped or interrupted run is not a
pass. Run one heavy Docker profile at a time across worktrees.

```!
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not inside a Git checkout"; exit 0; }
bash "$ROOT/tools/orchestration/verify.sh" "$ROOT" $ARGUMENTS 2>&1
printf '\nverify exit status: %s (0 = every gate passed)\n' "$?"
```
