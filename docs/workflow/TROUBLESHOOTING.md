# Workflow recovery

Read only when a helper fails. Normal commands: [COMMANDS.md](COMMANDS.md).

## Runtime and dependencies

- Requirements: Git, Bash 3.2+, Python 3.11+ for workflow/transfer, installed Node 24 and exact `packageManager` pnpm version.
  Helpers use the newest installed stable Node 24 from PATH/nvm and matching pnpm from local
  caches/PATH. Set `FDRIVE_NODE` / `FDRIVE_PNPM` to explicit installed binaries if necessary.
  A pnpm `.cjs` entry point is supported. Helpers never modify runtime installations.
- Setup uses noninteractive frozen installs, builds `@fdrive/db` and dependencies, then
  refreshes/checks the declared `fdrive-migrate` link. It never executes migrations.
- Incompatible pnpm store: inspect with `run-in-checkout.sh <checkout> -- pnpm store path`.
  Use the original store/permissions or a fresh checkout; do not replace user dependencies
  blindly. Re-run setup after dependency changes or a corrected setup failure.
- Python: reuse a valid service venv; otherwise prefer installed Python 3.12, then supported
  `python3`/`python`. `FDRIVE_PYTHON` overrides new venv creation. System dependencies remain
  explicit. See [INDEXER.md](../INDEXER.md) and [OCR.md](../OCR.md). No automatic apt/brew installs.
  Image-embedding unit tests need no downloaded model weights.
- Dev: Docker, curl and lsof must be available. Docker must already run. Resolve occupied ports before starting; never terminate an
  unrelated listener. Other ports/accounts: [DEVELOPMENT.md](../DEVELOPMENT.md).
  To stop dev containers while preserving data, run pinned `pnpm dev:env:down` explicitly.

## Locks and output

- Setup, verification and `run-in-checkout.sh ... --lock` share `.fdrive-workflow/command.lock`.
  Contention exits 75 immediately. Different worktrees run independently. Raw/unlocked commands
  bypass protection: do not overlap installs/tests in one checkout or Turbo with Playwright.
- Locks release on completion/failure/handled interrupts. After a hard kill, inspect the owner
  and verify its processes stopped before removing a stale lock. Helpers never steal locks.
- Full command logs live under ignored `.fdrive-workflow/logs`. Use the reported log path;
  `FDRIVE_VERBOSE=1` exposes full command output. Do not commit logs or paste entire logs into
  handoffs. Commands may print sensitive data even though wrappers never dump env/arguments.
- Concurrent browser tests need distinct checkouts and free ports. The browser harness selects
  ports by default; `E2E_API_PORT` / `E2E_WEB_PORT` override them when needed.

## Worktrees and integration

- `prepare-worktree.sh` rejects existing destinations/branches. Setup failure retains both;
  repair prerequisites and re-run setup there. Its stdout is only the new absolute checkout.
- Use `--working-tree` when workers need current uncommitted prerequisites. Its baseline is
  workflow state, not a commit. Do not edit/delete the baseline or mix it with commit merging.
- Transfer preflights conflicts and keeps both copies on failure. Resolve overlapping edits
  deliberately, review again, then retry. Never overwrite target edits just to make transfer pass.
- `ALLOWED` is an allowed-path-prefix regex; root `pnpm-lock.yaml` is always permitted by review.
  Inspect untracked contents too: `git diff HEAD` does not show them.
- Commit merges require a clean explicit target on the intended branch. Only a sole lockfile
  conflict is automatically regenerated; other conflicts stop. Resolve both intents, finish
  the merge, and verify. Never bypass hooks or lower gates to finish an integration.
- After an uncommitted transfer, retain the worker until target verification passes. Before
  cleaning a disposable checkout, recheck transfer equality for every changed/new file.
  Never use force removal merely to bypass dirty-worktree protection.

## Maintaining helpers

Mechanics live in `tools/orchestration/`, shared shell behavior in `command-lib.sh`.
Keep `--help`, this reference, and regression tests aligned. Tests use disposable fixtures;
no live installs, migrations, Docker, or application servers by default. Run `verify.sh`
with profile `workflow`; it discovers helper `test-*.sh` suites.

For workflow evaluation, compare equivalent commands on the same revision/runtime: record
exit status, output bytes, elapsed time, retries and correctness. Output bytes are a proxy,
not billed tokens. Total task-token comparisons require actual harness usage measurements.
