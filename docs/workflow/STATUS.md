# Current handoff

Updated: 2026-09-11. Unfinished product work: [plans](../plans/README.md).
Current implementation: [architecture](../ARCHITECTURE.md). Prior delivery evidence:
[history](STATUS-history.md). Historical branch/commit and in-progress labels are snapshots,
not current instructions.

## Beta field report (clean install, 2026-09-11): fixed

- **No worker had a CPU bound** (addendum widened this from `embed` alone). `deploy/compose.yaml`
  now sets thread counts explicitly where the amplification is thread-based —
  `FDRIVE_EMBED_THREADS` / `FDRIVE_IMAGE_EMBED_THREADS` (default 4) and `OMP_THREAD_LIMIT=1`
  on the indexer, whose `pytesseract` children each parallelised across every core on top of
  `INDEX_WORKERS` — and exposes opt-in `cpus:`/`mem_limit:` knobs on `indexer`, `ocr`, `tika`,
  `onlyoffice`, `embed` and `image-embed`. The hard caps default to 0/no limit because Docker
  rejects a `cpus:` above the host's core count; `tika` also gained `FDRIVE_TIKA_JAVA_OPTS`.
  Table in `deploy/REFERENCE.md#processing-worker-resource-limits`.
- **Controllers served `ready` with a stale `error`.** Neither the restart path nor
  `reconcile`'s ready branch cleared `_error`, so a worker stopped transiently (an api
  recreate during `update.sh`) kept a resolved reason attached until the retry window elapsed.
  Cleared on both paths in **both** `controller.py` and `office_controller.py`, which had the
  identical bug; regressions in each controller's tests.
- **Overload fed back into the controllers.** A loaded host slowed the api, the controller's
  2 s poll timed out, and 9 s of that stopped a healthy model child — whose reload loaded the
  host further and made the indexer log a connection error per file. `FeatureClient`/`OfficeClient`
  timeouts are now 5 s, and the poll loop separates a rejected document (fails closed after
  `FDRIVE_RUNTIME_STALE_SECONDS`, still 9 s) from an unreachable endpoint
  (`FDRIVE_RUNTIME_UNREACHABLE_SECONDS`, default 60 s) via a new `EndpointUnavailable`. Both
  still fail closed, and the stop reason now names which happened.
- **Not a bug: the api's health derivation.** `runtimeFailure` already requires the controller's
  `status` to be `failed` and never reads `error` on its own (`apps/api/src/system/runtime-status.ts:63`),
  and `controllerVerdict` only consults a controller when the sidecar itself is unreachable.
  The reported `search: failed` was accurate at probe time — the child really had been stopped
  by the loop above — and `/health` caches a fan-out for 15 s, so a later `/runtime` read can
  disagree with it.
- **Indexer hammered an absent embed backend.** One connection error per file (176 lines in
  one observed window). New `embed_backoff.py` gate: the first transport failure pauses
  embedding for 60 s and logs once, files keep their FTS chunks as `partial`, recovery logs
  once. `HTTPStatusError` and other answers from a live backend stay per-file.
- **`deploy/README.md` step 2** told a first-time operator to clone a private repo over
  anonymous HTTPS. Now the SSH form, with the access prerequisite stated.
- **CI never built the deployment images.** New `images` job builds `apps/web/Dockerfile` and
  `apps/api/Dockerfile`; both verified building locally. The two TypeScript errors the reporter
  hit were caught by CI's existing typecheck, but only after the push to `main` — the window in
  which an operator pulls a `main` that does not build is a direct-to-main consequence, not a
  missing check.
- Not reproduced: `docs/workflow/P10-WEBDAV.md` no longer exists, and `docs/STORAGE-PROVIDERS.md`
  already states WebDAV is unimplemented.
- Left alone: `indexer.wait_for_embed` is dead production code (tests only). The backoff gate
  supersedes it; removal is a separate cleanup.
- Gates: `workflow`, `python runtime`, `python indexer` all pass; both deployment images build. No application/browser change.

## 65-finding code audit: complete

- All 65 user-supplied findings resolved on `main`, one dedicated subagent per finding and a
  separate commit per fix. 50 fixed, 12 rejected with evidence, DB-03 covered by DB-01/02,
  SEC-08 real but deliberately unfixed, FS-06 an upstream limitation.
- Per-finding verdicts, evidence and limits: [BUG-AUDIT-2026-09-11.md](BUG-AUDIT-2026-09-11.md).
- Final gates on `main`: `application`, `integration` (real PostgreSQL and SFTPGo containers),
  affected `browser` specs, and `workflow` all pass.
- Two reported root causes were disproved rather than implemented: SEC-04's username fan-out
  does not reproduce (the exhaustible axis is IPv6 /64 address supply), and DB-10's 32-bit
  local column does not exist, since SFTPGo owns that value and the bundled SQLite provider
  is unaffected.
- Open for the maintainer: SEC-08 needs either edge rate limiting keyed by IPv6 /64 or a
  minimum share-password strength; both are deployment or product decisions, not audit fixes.
- Issue patches, the per-finding ledger and verification logs: `.fdrive-workflow/audit-20260911/`.

## Issue #2: remaining findings

- Findings 4, 6, 14 and 15 remained relevant and are now committed on `main`.
- Added five non-partial FK indexes in migration `0002_foreign_key_indexes`; existing
  primary/unique indexes already cover the other reported columns. PostgreSQL catalog
  regression verifies a usable leading-column index for every app FK, including SET NULL.
- Identity overrides accept only indexed roots plus their own provider's template root;
  installation-wide shared mappings retain the union. Cross-provider regression passes.
- About attribution includes disabled configured provider types; enabled login connections
  and endpoint privacy remain separate. Unit, composed-app and browser regressions pass.
- Auth fixtures preserve original session age across switch/rotate/unlink, keep lastSeenAt
  consistent, clear cached tokens on verified login/link, and remap used tags on transfer/unlink
  while retaining destination tag colors and other identities' metadata.
- Application lint/typecheck and all package/tool coverage pass with bounded concurrency
  (`.fdrive-workflow/logs/step.k5nzVY/`). The first default-worker coverage run failed with
  `Streamable HTTP error: Error POSTing to endpoint: auth required` in the MCP fixture
  (`step.VG6vco`); no production MCP change or relaxed gate was made.
- Full integration passes (DB 274, API 35, SFTPGo 72, testkit 9; `step.6iyNZq`). About and
  account-scope browser tests pass 6/6 on the disposable Next dev stack (`step.EKL5gx`).
- Live Next dev inspection passed with disposable SFTPGo/Postgres: all providers disabled,
  attribution visible, enabled-provider list empty and setup complete. Screenshot:
  `.fdrive-workflow/evaluation/issue2-about-disabled.png`.
- First workflow attempt hit the unchanged mock-startup regression assertion
  `missing pnpm <--filter> <@fdrive/api> <dev>` (`step.TRXZTY`); full workflow rerun
  passed unchanged, including lint and diff checks.
- Committed and pushed as `df51078` (FK indexes), `dd7e781` (about attribution),
  `2b9bedc` (identity override roots) and `093b71b` (auth fixtures); the first eleven
  findings were already pushed. No GitHub issue closure performed.

## Agent configuration and guard

- Instruction files are split by audience. `AGENTS.md` (read by Codex, and by Claude through
  `CLAUDE.md`) and `WORKING.md` are runtime-neutral; delegation, roles, model policy and
  worktree handoffs moved to `docs/workflow/ORCHESTRATION.md`, which now has a section per
  runtime. `CLAUDE.md` imports all three, so Claude Code sees what it did before.
- Codex 0.153.4 does have subagents (`spawn_agent`; the `multi_agent` feature is stable and on,
  `multi_agent_v2` is off, so V1 settings apply). Worker model and effort are pinned in
  `.codex/config.toml` under `[agents]` to `gpt-5.6-sol` at `high`; without it subagents
  inherit the primary model. The table name was confirmed by type-error probe, not docs.
- `.codex/config.toml` also registers the same PreToolUse guard. Codex ships the matching
  `PreToolUseHookSpecificOutputWire` schema, so the guard's deny payload is understood by both
  runtimes; its matcher is `.*` because Codex tool names differ from Claude's.
- The guard now dispatches on payload shape when it does not recognise the tool name: a
  `command` string is a shell call, a path plus replacement content is an edit, a path alone is
  not. Covered by new cases in `test-guard-tool-use.sh`.
- Unverified: no Codex session has exercised the hook yet, so hook trust (Codex records a
  `trusted_hash` per command) and the real tool-call payload shape are unconfirmed. The
  lockfile rule may need a field name added once a Codex edit payload is observed.

- Added `CLAUDE.md` importing `AGENTS.md` and `WORKING.md`: Claude Code loads `CLAUDE.md`, not
  `AGENTS.md`, so the working agreements were not reaching sessions before this.
- `implementer` and `test-writer` carry tool allowlists; neither can delegate. Added read-only
  `explorer` (sonnet, medium effort) for evidence gathering.
- A PreToolUse guard (`tools/orchestration/guard-tool-use.{sh,py}`, registered in
  `.claude/settings.json`) refuses SHA-less stash operations, `git reset --hard`,
  `git clean -f`, `git push --force`, lockfile hand-edits and session links. Commit and merge
  paths are untouched, so `merge-chunk.sh` is unaffected. The same rules stay stated in
  WORKING.md so they are known before an attempt.
- Step logs prune to a count cap, `FDRIVE_LOG_RETENTION_COUNT` (default 300, `0` disables,
  malformed values prune nothing). An age window was tried first and did not bound size at
  the rate these accumulate; the cap holds at roughly 4 MB regardless of rate. Covered by
  `test-log-retention.sh`.
- Added a `/fdrive-verify <profile>` skill that runs a profile in the current checkout. The
  name avoids a collision: a bundled Claude Code skill owns `/verify` and shadows a project
  skill of that name, which is not obvious from the failure. Agents may still call
  `verify.sh` directly, as WORKING.md directs.
- `verify workflow` passes, including the new `test-guard-tool-use.sh` regression group.
  This change is configuration, documentation and workflow tooling only; no application,
  browser or security verification is claimed.

## Documentation cleanup

- Added the storage-provider developer guide; removed five obsolete P10 briefs.
- Removed completed P2–P9/UX/onboarding briefs and the mixed root plan. Unfinished features,
  fixes/verification and deferred ideas now have separate documents under `docs/plans/`.
- Preserved current scope/Office/security contracts in developer references, moved dated
  handoffs to history and updated source-comment/document links.
- Cleanup passed the workflow gate and local link/anchor checks; independent backlog review
  confirmed remaining requirements survived. Existing application/test/pentest diffs were
  preserved exactly. The earlier provider guide also passed its TypeScript example typecheck.

## Checkout

- `main`; only the remaining issue #2 fixes and their verification notes are uncommitted.
- Earlier provider/auth/pentest and documentation changes were committed and pushed before
  this follow-up. Detailed historical security findings remain in
  [pentest findings](SHANNON-PENTEST-FINDINGS.md).

## Established verification

- Phase 5 full strict performance passed, including search25k p95 195.82 ms (<300).
- Provider binding has integrated two-HTTP-server fixture coverage (SFTPGo fakes).
- Remaining feature/verification gaps are listed in plans; completed work and old worker
  assignments must not be restarted from historical briefs.
