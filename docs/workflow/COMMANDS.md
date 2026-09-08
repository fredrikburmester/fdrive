# Workflow commands

Policy and model selection: [WORKING.md](../../WORKING.md). Run examples from the repository
root unless stated otherwise. Replace example chunk/package/test names with the assigned scope.
No helper commits, merges, runs migrations, starts Docker, or modifies user runtime installations
unless the command explicitly requests that operation.

## Setup and runtime

Requirements: Git, Bash 3.2+, installed Node 24, and the exact pnpm version in `package.json`.
The helpers accept explicit `FDRIVE_NODE` / `FDRIVE_PNPM` paths, otherwise discover installed
the newest installed Node 24 from PATH/nvm and pinned pnpm from local caches or PATH. Selected binaries apply to nested
package scripts too. Missing or mismatched runtimes fail with a diagnostic; nothing is downloaded
automatically. `--help` works before setup.

```bash
FDRIVE_ROOT="$(git rev-parse --show-toplevel)"
FDRIVE_TOOLS="$FDRIVE_ROOT/tools/orchestration"
bash "$FDRIVE_TOOLS/setup-checkout.sh" "$FDRIVE_ROOT"
```

Setup holds the checkout lock, installs with `--frozen-lockfile`, builds `@fdrive/db` and its
buildable dependencies, and refreshes/checks pnpm's declared `fdrive-migrate` link. It never
executes that binary. Re-run after dependency changes. A failed install/build stops immediately.
Installs are noninteractive. If existing dependencies use a different pnpm store, setup refuses
to replace them; use the original store/permissions or prepare a fresh worktree. To inspect the
selected store, run `run-in-checkout.sh <checkout> -- pnpm store path`.

An explicit runtime override, if discovery cannot find your installation:

```bash
FDRIVE_NODE=/absolute/path/to/node FDRIVE_PNPM=/absolute/path/to/pnpm.cjs \
  bash "$FDRIVE_TOOLS/setup-checkout.sh" "$FDRIVE_ROOT"
```

Run arbitrary argv in an explicit checkout, from any directory:

```bash
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_ROOT" -- node --version
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_ROOT" -- pnpm --version
```

## Prepare a worker worktree

Primary only. Source is committed HEAD, including when the source checkout is on a feature
branch. Existing branches/paths are rejected. Copy required uncommitted specs/prerequisites
explicitly after creation and include them in the worker's baseline/review scope.

```bash
FDRIVE_CHUNK=example-chunk
FDRIVE_WT="$(bash "$FDRIVE_TOOLS/prepare-worktree.sh" "$FDRIVE_ROOT" "$FDRIVE_CHUNK")"
```

Success prints only the absolute checkout path to stdout. Progress goes to stderr. The branch
is `codex/<chunk>` and the default path is `.worktrees/<chunk>`; a third argument overrides the
path. If setup fails, the worktree/branch remain for inspection. Re-run `setup-checkout.sh` on
that checkout after fixing the reported issue; don't create another worktree over it.

## Gemini workers through agy

Requires Python 3.11+ and an installed, authenticated `agy`. The user-selected default is
Gemini 3.8 Flash high (`gemini-3.8-flash-high`), pinned in `agy-worker-defaults.json` beside the
runner. This slug was verified with `agy models`. Never substitute GPT if it is unavailable.
Set `FDRIVE_AGY=/absolute/path/to/agy` if the executable is not on PATH. The runner never
installs software or signs in. The explicit `setup` command configures scoped permissions;
`start` and `followup` never change settings.

After preparing the separate worktree above, write a complete specification with owned paths,
interfaces, acceptance criteria, and required gates. Use the primary checkout's runner:

```bash
bash "$FDRIVE_TOOLS/worker.sh" setup --checkout "$FDRIVE_WT"
bash "$FDRIVE_TOOLS/worker.sh" start \
  --checkout "$FDRIVE_WT" --spec /absolute/path/to/spec.md \
  --role implementer --model gemini-3.8-flash-high --effort high --timeout 1800
bash "$FDRIVE_TOOLS/worker.sh" status JOB_ID
bash "$FDRIVE_TOOLS/worker.sh" followup JOB_ID --spec /absolute/path/to/revision.md
bash "$FDRIVE_TOOLS/worker.sh" stop JOB_ID
```

Replace `JOB_ID` with the `job_id` in the start response. For tests alone use `--role test-writer`.
Omit `--model` and `--effort` to use the pinned defaults. Overrides must be explicit Gemini slugs
from `agy models`; successful initialization must confirm the requested model exactly.
`--root /absolute/primary/checkout` before the command overrides the registry location; otherwise
it is the repository containing the runner. Every response is JSON. Start returns immediately;
poll status for progress and completion. Stop requests cancellation and returns immediately;
poll until `live` is false before reusing the worktree. Requests while a turn is active are
rejected; send follow-ups after it finishes. Follow-ups preserve model, effort, checkout and
the explicit conversation ID. Each turn runs a fresh agy process with the previous conversation;
there are no idle agent processes between turns.

The private, ignored `.fdrive-workflow/agy-workers/JOB_ID/` holds the configuration, lease,
status, and per-turn prompt, NDJSON event log, stderr and result. Treat logs as potentially
sensitive tool output; do not commit or publish them. The runner requires a linked `codex/`
worktree belonging to the primary repository, refuses duplicate active checkout ownership,
and caps its own active workers at three. The orchestrator must also count older native workers.
Worker ownership is separate from the command lock, so workers can run locked tests normally.
Do not run installs, tests, edits or integration in a worker-owned checkout concurrently.

The supervisor owns the agy process group, timeout and cleanup. Status checks a held process
lease rather than assuming a saved PID is still the same process. `supervisor_lost` blocks new
launches: inspect the recorded process and any descendants manually before retiring that job's
registry directory. Never delete a lease or restart just because observation timed out.

No run is marked verified by the runner:

- `needs_review`: zero exit, expected model/checkout, matching conversation and a successful
  terminal event. Review the saved result, stderr and events, actual diff and tests.
- `needs_attention`: agy reported success, but denied actions, tool errors or known permission-denial notices
  were detected. Inspect and resolve these before accepting the work.
- `failed`, `timed_out`, `stopped`: incomplete; preserve the worktree for review/recovery.

`setup` validates a linked `codex/` worktree and preserves existing settings and rules in
`~/.gemini/antigravity-cli/settings.json`. It adds checkout file access and command grants for
only the absolute `bash .../run-in-checkout.sh CHECKOUT --lock --` and
`bash .../verify.sh CHECKOUT` prefixes. Use those exact helper forms in worker specs.
Changed settings receive a private backup; repeated setup is idempotent. Existing ask/deny
rules remain authoritative and are reported for review. No blanket permission grant is added.
Setup rejects paths with whitespace or permission-grammar metacharacters; use a simple
worktree path such as `.worktrees/p5-search`. Command path tokens are escaped as literal regex.

agy is launched with `--mode accept-edits --add-dir CHECKOUT`, with no permission bypass flag.
The working directory
and ownership prompt are not an OS sandbox; use your environment's sandbox where required.
Sandbox denial of agy's local listener or configuration/log access needs an authorized execution
environment, not a fallback model. Never equate exit zero with passing tests: headless agy can
soft-deny tools. The runner conservatively flags known errors; human/orchestrator review remains
mandatory. Official protocol: <https://antigravity.google/docs/cli/headless/>.

Offline regression suite (uses fake CLI processes and disposable Git worktrees only):

```bash
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_ROOT" --lock -- \
  python3 tools/orchestration/test_agy_worker.py
```

Before the first real rollout, use a disposable worktree and a spec to create one harmless
text file and run a simple check. Verify the actual file, selected model, terminal event and
follow-up conversation. Do not migrate or interrupt existing workers for this smoke test.

## Verification

| Profile | Invocation | Requirements / coverage |
| --- | --- | --- |
| Workflow | `bash "$FDRIVE_TOOLS/verify.sh" "$FDRIVE_ROOT" workflow` | Python 3.11+; shell/TOML checks, helper regressions, lint, diff check |
| Package | `bash "$FDRIVE_TOOLS/verify.sh" "$FDRIVE_WT" package @fdrive/core` | Exact package name; lint, package typecheck and coverage |
| Application | `bash "$FDRIVE_TOOLS/verify.sh" "$FDRIVE_ROOT" application` | Repository lint, typecheck, coverage |
| Integration | `bash "$FDRIVE_TOOLS/verify.sh" "$FDRIVE_ROOT" integration` | Docker; additional to application gates |
| Browser | `bash "$FDRIVE_TOOLS/verify.sh" "$FDRIVE_WT" browser e2e/shares.spec.ts` | Docker, installed Chromium; omit test arguments for full suite |
| Python | `bash "$FDRIVE_TOOLS/verify.sh" "$FDRIVE_WT" python indexer` | Service venv; ruff, mypy, coverage; indexer also runs Docker inotify suite |

Each profile runs sequentially under one checkout lock, streams output, and preserves the
first failing command's exit code. Python profiles support `indexer`, `ocr`, `image-embed`;
root application gates do not run Python. No profile silently replaces another required gate.

Install Chromium once, then run browser tests (the harness chooses free ports by default):

```bash
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_WT" --lock -- \
  pnpm --filter @fdrive/web exec playwright install chromium
E2E_API_PORT=3101 E2E_WEB_PORT=3102 \
  bash "$FDRIVE_TOOLS/verify.sh" "$FDRIVE_WT" browser e2e/shares.spec.ts
```

Custom focused check, using the same checkout lock:

```bash
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_WT" --lock -- \
  pnpm --filter @fdrive/core test
```

Python venv preparation, from the selected service directory (Python 3.12+):

```bash
cd "$FDRIVE_WT/services/indexer"
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
```

The indexer also needs its system extraction dependencies; see [INDEXER.md](../INDEXER.md).
OCR tests use containers; image embedding unit tests do not require downloaded model weights.

## Run the dev app

Docker must already be running. From the primary shell with `FDRIVE_ROOT` / `FDRIVE_TOOLS` set:

```bash
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_ROOT" -- pnpm dev:env
# Optional search, thumbnails, OCR, embeddings:
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_ROOT" -- \
  docker compose -f deploy/compose.dev.yaml --profile index up -d
```

Start each server in its own persistent terminal; set the same two variables in each terminal:

```bash
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_ROOT" -- pnpm --filter @fdrive/api dev
bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_ROOT" -- pnpm --filter @fdrive/web dev --port 3002
```

API uses 3001; choose a free web port. Open the printed URL, log in with `dev` / `dev`.
Restart after env/dependency changes. Stop containers while keeping data:
`bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_ROOT" -- pnpm dev:env:down`.
Other ports/accounts: [DEVELOPMENT.md](../DEVELOPMENT.md).

## Review, merge, cleanup

Primary only, after the worker finishes. `ALLOWED` is a regex of allowed path prefixes;
root `pnpm-lock.yaml` is always allowed by the existing scope helper. Inspect new files too:
`git diff HEAD` alone does not show untracked contents.

```bash
ALLOWED='packages/core/|packages/contracts/' \
  bash "$FDRIVE_TOOLS/review-chunk.sh" "$FDRIVE_WT"
git -C "$FDRIVE_WT" status --short
git -C "$FDRIVE_WT" diff HEAD
```

Only when commits are requested: select an explicit clean target on the intended branch,
then run the existing merge helper with selected runtime and target lock:

```bash
FDRIVE_TARGET="$FDRIVE_ROOT"
git -C "$FDRIVE_TARGET" branch --show-current
git -C "$FDRIVE_TARGET" status --short
ALLOWED='packages/core/|packages/contracts/' \
  bash "$FDRIVE_TOOLS/run-in-checkout.sh" "$FDRIVE_TARGET" --lock -- \
  bash "$FDRIVE_TOOLS/merge-chunk.sh" "$FDRIVE_WT" "feat(core): describe the chunk" "$FDRIVE_TARGET"
bash "$FDRIVE_TOOLS/verify.sh" "$FDRIVE_TARGET" application
```

The merge helper commits the chunk and merges with `--no-ff`, preserving hooks. It regenerates
only a sole lockfile conflict; other conflicts stop. Delegate code resolution in the target as
an explicit isolation exception; preserve both intents, then the primary completes the merge.
Run additional profiles required by the change. Without a commit request, transfer the reviewed
diff and new files as uncommitted changes and verify before discarding the worker copy.

Once fully integrated, verified, and clean:

```bash
git worktree remove "$FDRIVE_WT"
git branch -d "codex/$FDRIVE_CHUNK"
```

A dirty worktree is deliberately rejected. For uncommitted transfers, verify every tracked/new
file before cleaning the disposable checkout; never force-remove unreviewed changes.

## Locks, logs, and helper maintenance

Setup, verification, and `run-in-checkout.sh ... --lock` share an atomic lock in the checkout's
ignored `.fdrive-workflow/command.lock` directory. Another helper exits 75 immediately on contention. Different worktrees can
run independently. Locks are released on normal completion/failure and handled interrupts;
after a hard kill, inspect the reported owner and ensure nothing is running before removing
a stale lock. Helpers never steal one automatically. Unlocked commands bypass protection.

Start/end and exit status go to stderr; child output streams normally. Helpers do not dump
arguments or environment values. Underlying commands remain responsible for their own output.

The five helpers share `command-lib.sh`; keep mechanics there and usage here. Regression tests
use disposable fixtures, never live installs, migrations, Docker, or application servers:

```bash
bash "$FDRIVE_TOOLS/test-command-helpers.sh"
bash "$FDRIVE_TOOLS/test-orchestration.sh"
```

Test-only `FDRIVE_HELPERS_DIR` can point at another checkout's `tools/orchestration` directory
when reviewing helpers before integration. Update tests and this command reference together
when changing helper interfaces.
