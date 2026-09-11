# Workflow commands

Policy: [WORKING.md](../../WORKING.md). Read this reference only for the task at hand.
From any checkout root, set `T="$PWD/tools/orchestration"`; every helper takes an explicit
checkout root. Setup/dev/prepare/verify/transfer support `--help` without setup. Helpers
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
Setup never runs migrations. Python services: `indexer`, `ocr`, `image-embed`.

## Verification

Run `bash "$T/verify.sh" "$PWD" <profile> [args]` in the checkout being verified.
You can also type `/fdrive-verify <profile>` to run this in the current checkout. The name
is deliberate: a bundled Claude Code skill already owns `/verify` and would shadow it.

| Profile | Checks / prerequisites |
| --- | --- |
| `workflow` | Shell/Python syntax, `.claude/agents` definitions, helper regressions, lint, diff check |
| `package @fdrive/core` | Repository lint, named package typecheck/coverage |
| `application` | Repository lint, typecheck, coverage |
| `integration` | Container integration tests; Docker |
| `browser e2e/shares.spec.ts` | Affected Playwright tests; Docker/Chromium; omit args for full suite |
| `python indexer` | Service ruff/mypy/coverage; indexer also Docker inotify |

Profiles fail on the first failed gate and share the checkout lock. CI uses the same helpers.
PASS/FAIL summaries are compact; full logs are retained. `FDRIVE_VERBOSE=1` shows full output.
A failure excerpt is bounded: read its log for more detail rather than rerunning for output.

## Delegated changes (primary)

```bash
WT="$(bash "$T/prepare-worktree.sh" "$PWD" example-chunk --working-tree)"
ALLOWED='packages/core/|packages/contracts/' bash "$T/transfer-checkout.sh" --diff "$WT"
ALLOWED='packages/core/|packages/contracts/' bash "$T/transfer-checkout.sh" --check "$WT" "$PWD"
ALLOWED='packages/core/|packages/contracts/' bash "$T/transfer-checkout.sh" "$WT" "$PWD"
```

`--working-tree` includes nonignored uncommitted prerequisites and records a baseline;
omit it for committed HEAD. Review the actual delta/new files as well as scope-checking.
Transfer checks target conflicts before writing and verifies the resulting files; no commits.
Run required target profiles before cleanup. Do not remove a worker's only unreviewed copy.

When commits are requested, use a HEAD-based worker and an explicit clean target:

```bash
ALLOWED='packages/core/' bash "$T/run-in-checkout.sh" "$PWD" --lock -- \
  bash "$T/merge-chunk.sh" "$WT" "feat(core): describe change" "$PWD"
```

The merge helper commits/merges with hooks; inspect the target branch first. Re-run required
profiles afterward. Remove fully integrated, verified, clean worktrees with `git worktree remove`
and delete their merged branches with `git branch -d`. Dirty transfers: see recovery reference.
