# Current handoff

Updated: 2026-09-11. Unfinished product work: [plans](../plans/README.md).
Current implementation: [architecture](../ARCHITECTURE.md). Prior delivery evidence:
[history](STATUS-history.md). Historical branch/commit and in-progress labels are snapshots,
not current instructions.

## Issue #2: concurrency

- #11 implemented: snapshot before upstream authentication; compare under persistence locks;
  reject stale differing credentials without revoking newer sessions. Same-password concurrent
  replacements retain both sessions. Memory fixture follows the same decision callback.
- Deferred API regressions and real PostgreSQL concurrent replacement regression pass.
  All application gates pass using reduced-concurrency coverage; integration passes.
- #11 committed as `f8b8b55`.
- #8–10 implemented: insert-only provider creation, uniqueness conflict translation,
  and a provider row lock around deletion/checks. Matching memory repository behavior.
  Concurrent create, readdress, and delete/login regressions pass on PostgreSQL;
  application gates and full integration pass.
- Provider fixes committed as `e413915`.
- #3 implemented: per-identity coalescing, generation checks and ordered database writes
  prevent stale mint results from surviving invalidate/prime. Scope cache completions
  can only update/remove the in-flight entry they own. Deferred race regressions, all
  application gates and full integration pass.
- Remaining: setup cleanup (#7).
  Acceptance criteria: [concurrency plan](../plans/CONCURRENCY.md).

## Issue #2: quick fixes

- Items 2, 5, 12 and 13 implemented locally: uploads forward request cancellation;
  upstream 416 maps to `bad_request` (public shares return 400 instead of 502);
  spare-provider E2E cleanup sends the CSRF header and checks success; auth docs use
  `currentCredential`. The obsolete probe document was already removed.
- Regressions cover cancellation with and without a body, client error classification
  (412 stays unchanged), and removal of a provider left by an interrupted browser run.
- Lint and typecheck pass. Default parallel coverage hit the two existing 5000ms archive
  test timeouts (`.fdrive-workflow/logs/step.IIsiDj/`); all package coverage passes with
  `turbo run test:coverage --concurrency=1 -- --maxWorkers=2`
  (`.fdrive-workflow/logs/step.OvSddD/`). No gates or timeouts changed.
- Integration passes against disposable SFTPGo/PostgreSQL. Storage browser tests pass
  with `E2E_DEV=1`, including the new leftover-provider cleanup regression. Tooling
  coverage and workflow verification pass. Committed and pushed as `7b097d2`.

## Issue #2: descendant move/copy guard

- Item 1 implemented locally: normalized descendant targets return 400 before storage,
  metadata or events; equal-path API no-ops remain supported. Move/copy pickers exclude
  selected subtrees and require a valid destination for every selected source.
- Regression coverage checks preserved file contents, no mutation/event side effects,
  normalized paths, sibling prefixes and both picker flows. Focused API tests, lint and
  typecheck pass. Integration passes; all 9 move/copy browser tests pass against disposable
  SFTPGo/PostgreSQL with `E2E_DEV=1`. Interactive dev check confirmed the selected folder
  is hidden, same-parent confirmation disabled, and a valid sibling destination enabled.
- Default parallel application coverage hit existing archive/trash test timeouts
  (`.fdrive-workflow/logs/step.pkuX6l/`). All package coverage passes with
  `turbo run test:coverage --concurrency=1 -- --maxWorkers=2`
  (`.fdrive-workflow/logs/step.pmRLLk/`); no timeouts or thresholds changed.
- Committed on `main` as `4d80db3` at the user's request.

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

## Existing checkout work

- Provider/auth isolation edits and tests, Playwright configuration, pentest findings and
  `PR-REVIEW-FINDINGS.md` predate this cleanup and remain uncommitted. The documentation
  cleanup was moved to `main` for the requested commit; no push requested.
- Detailed security followups: [pentest findings](SHANNON-PENTEST-FINDINGS.md).
- This cleanup changes documentation and source comments only. It does not claim new
  application, browser, performance or security verification.

- Previous local main history is retained on `codex/main-before-docs-cleanup`; main now
  starts from the merged PR #1. Its base tree matched the documentation checkout exactly.

## Established verification

- Phase 5 full strict performance passed, including search25k p95 195.82 ms (<300).
- Provider binding has integrated two-HTTP-server fixture coverage (SFTPGo fakes).
- Remaining feature/verification gaps are listed in plans; completed work and old worker
  assignments must not be restarted from historical briefs.
