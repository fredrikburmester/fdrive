# Workflow commands

Native macOS build/tests: `bash tools/orchestration/verify-macos.sh "$PWD" [TEAM_ID]`.
Without a team this builds unsigned; with a team it uses Xcode development signing.
See [MACOS.md](../MACOS.md) for Finder verification and release qualification.

Policy: [WORKING.md](../../WORKING.md). Read this reference only for the task at hand.
From any checkout root, set `T="$PWD/tools/orchestration"`; every helper takes an explicit
checkout root. Setup/dev/verify support `--help` without setup. Helpers
select installed Node 24 and pinned pnpm automatically. Recovery and overrides: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Setup and development

| Task | Command |
| --- | --- |
| Install frozen dependencies and build/link DB binary | `bash "$T/setup-checkout.sh" "$PWD"` |
| Prepare Python service venv (installed Python 3.12+) | `bash "$T/setup-python.sh" "$PWD" indexer` |
| Start dev dependencies, API/web; wait for readiness | `bash "$T/dev-app.sh" "$PWD" --web-port 3002` |
| Include optional search/thumbnail/AI services | Add `--index` to dev command |
| Install browser test dependency | `bash "$T/run-in-checkout.sh" "$PWD" --lock -- pnpm --filter @fdrive/web exec playwright install chromium` |
| Custom focused check | `bash "$T/run-in-checkout.sh" "$PWD" --lock -- pnpm --filter @fdrive/core test` |
| Read-only command with pinned runtime | `bash "$T/run-in-checkout.sh" "$PWD" -- node --version` |

Dev needs Docker already running; use a persistent terminal. Ctrl-C stops owned servers,
keeping container data. Login `dev` / `dev`; restart after env/dependency changes.
Setup never runs migrations. Python services: `indexer`, `ocr`, `image-embed`, `runtime`.

## Verification

Run `bash "$T/verify.sh" "$PWD" <profile> [args]` in the checkout being verified.
You can also type `/fdrive-verify <profile>` to run this in the current checkout. The name
is deliberate: a bundled Claude Code skill already owns `/verify` and would shadow it.

| Profile | Checks / prerequisites |
| --- | --- |
| `workflow` | Shell/Python syntax, helper regressions, lint, diff check |
| `package @fdrive/core` | Repository lint, named package typecheck/coverage |
| `application` | Repository lint, typecheck, coverage |
| `integration` | Container integration tests; Docker |
| `browser e2e/shares.spec.ts` | Affected Playwright tests; Docker/Chromium; omit args for full suite |
| `python indexer` | Service ruff/mypy/coverage; indexer also Docker inotify |

Profiles fail on the first failed gate and share the checkout lock. CI uses the same helpers.
Hosted CI is budgeted (private repository, 2000 free minutes a month): pull requests run only
`application` (`CI`) plus all four Python service gates when their service paths change (`Python services`).
The `ci:full` PR label or `gh workflow run "CI (full)" --ref <ref>` runs everything; nothing runs
on push to `main`, so dispatch `CI` or `CI (full)` for `main` after a direct commit.
PASS/FAIL summaries are compact; full logs are retained. `FDRIVE_VERBOSE=1` shows full output.
A failure excerpt is bounded: read its log for more detail rather than rerunning for output.
