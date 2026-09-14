# Backup implementation handoff

Updated 2026-09-14 after resuming the stopped work. Read `WORKING.md`, `docs/BACKUPS.md` and
`docs/plans/BACKUPS.md` first; this file holds evidence and the exact remaining items.

## Checkout

- Worktree `/private/tmp/fdrive-backups`, branch `codex/backups`, based on `5ff87c9`.
  All work is uncommitted, including many untracked files. Main checkout has unrelated WIP.
- No commit, merge, push, deployment or production connection was requested.
- Docker Desktop stopped during the session (socket absent, no processes); it was relaunched
  with `open -a Docker` to continue container gates. No unrelated containers were touched.

## Changes in this session

- Fixtures: `roundtrip.test.ts` confirms the key before scheduling and passes a string owner to
  `BackupEngine.queue`; web health test `act` typing; API route test typed JSON body.
- `packages/backup/src/destinations.ts`: `probeDestination` returns `{ retained }`; a probe the
  destination refuses to delete is accepted only when `information()` reports `retentionUntil`.
- `engine.testDestination` stores `config.retainedProbe` and logs an event; routes expose
  `retainedProbe`; contract and destination card show the kept object and deadline.
- `engine.cleanSpool` also removes, after 24 h, orphaned final archives whose run is gone or
  settled (never queued/active/pinned or artifact-owning), stale local completion markers, and
  partials; unknown names and vanishing files are left alone.
- `BackupOperations.estimatePending` bounds one estimate by `estimateDeadlineMs` (10 min) and
  treats connection failures as a failed estimate.
- `module.destinationRecord` strips transient credential fields before verification, so the
  saved credential is the one that was proven to sign in unattended; UI copy says so.
- Tests: retained probe (destinations, roundtrip), spool sweep, estimate failures, route
  pass-through, page rendering, credential stripping, CLI cutover/rollback rehearsal
  (`recovery.test.ts`), WebDAV+SFTPGo 64 MiB destination qualification
  (`apps/api/test/integration/backups.test.ts`), benchmark
  (`packages/backup/test/integration/benchmark.test.ts`), browser health checks.
- Docs: health, annotation review, replacement/rollback, rehearsal and measured costs in
  `docs/BACKUPS.md`; plan and STATUS rewritten.

## Evidence on the current tree

| Check | Result |
| --- | --- |
| `pnpm -r typecheck` | pass |
| `pnpm lint` (Biome) | no errors; pre-existing style warnings in unrelated desktop files |
| `@fdrive/backup test:coverage` | 44 tests, 99.18 / 95.78 / 100 / 99.79 (`step.dtDdui`) |
| `@fdrive/api vitest src/backups/recovery.test.ts` | see final gates below |
| `@fdrive/api` integration `backups.test.ts` | 2 tests pass; timings in `.fdrive-workflow/evaluation/backup-destinations.json` |
| Backup benchmark | `.fdrive-workflow/evaluation/backup-benchmark.json` |
| Web focused suites | 12 tests pass; page test for retained probe added afterwards |

## Remaining

- Real AWS S3 and Backblaze B2 qualification: waiting for the owner's dedicated bucket names,
  endpoints and credential profiles (names only, never secrets). Do not infer bucket authority.
- Hosted CI dispatch (`CI (full)`) before merge; Actions is disabled for cost.
- Real host cutover on a deployed installation following the documented procedure.
- Follow-ups noted in the plan: release the checkpoint once sources are pinned if captures
  grow long; batch legacy OCR mapping lookups for large inventories.

## Commands

```sh
bash tools/orchestration/verify.sh "$PWD" application
bash tools/orchestration/verify.sh "$PWD" integration
bash tools/orchestration/verify.sh "$PWD" browser e2e/backups.spec.ts
bash tools/orchestration/verify.sh "$PWD" workflow
bash tools/orchestration/run-in-checkout.sh "$PWD" --lock -- pnpm --filter @fdrive/backup exec vitest run --config vitest.integration.config.ts test/integration/benchmark.test.ts
```

Helpers select Node 24 / pnpm 10; installs use `--store-dir /private/tmp/fdrive-backups-pnpm-store`.
One heavy Docker suite at a time. The `desktop-effects` db integration tests time out under
load and pass alone; that is pre-existing.

## Manual smoke test in a real browser (2026-09-14 evening)

Driven interactively in Playwright's Chromium (the Claude in Chrome extension never connected;
the app's built-in pane does not hydrate Next dev pages) against the worktree's dev API and web,
a fresh `fdrive_backups_smoke` database in the dev PostgreSQL, the dev SFTPGo container and a
local MinIO with a versioned bucket plus an Object Lock bucket with a one-day default
governance retention. Next only hydrates on `http://localhost:3002`, not `127.0.0.1`.

Exercised end to end: owner unlock, recovery key kit download and confirmation, ZIP upload,
SFTPGo and both MinIO destinations (probe, delivery, completion markers, exact version IDs),
retained probe shown with its deadline, local download decrypted and its ZIP extracted
byte-identical with the offline CLI, `backup list`/`fetch` with fileserver-only and S3-only
destination files, `backup rehearse` into a fresh database and the report uploaded through the
health panel, byte verification, size estimate, daily schedule, and deletion of a run whose
locked copy stays behind.

Defect found and fixed: deleting a run with an Object Lock copy removed the other copies and
then returned HTTP 500 with nothing shown. `engine.remove` now records the deadline on the
retained delivery, keeps the catalog entry and throws `BackupRetainedError`; the route answers
409 with the copies that remain and the page shows it. Dev SFTPGo's own Trash rule keeps
deleted probes under `.trash`; documented as fileserver behavior.

Screenshots: `.playwright-mcp/smoke-*.png` in the main checkout. Left behind for the owner to
drop: databases `fdrive_backups_smoke` and `fdrive_backups_rehearsal_*` in the dev PostgreSQL,
the stopped container `fdrive-smoke-minio`, and `/private/tmp/fdrive-backups-dev-state`.

## Real Backblaze B2 (2026-09-14 evening)

The owner entered a throwaway application key into the destination form in the app's browser
pane; the agent prefilled the non-secret fields and never handled the key. Bucket
`fdrive-local-test` on `s3.us-west-004.backblazeb2.com`, virtual-host addressing, prefix
`fdrive-backups/<installation>`. Passed: probe (create, read, delete), delivery with full
readback (run `48c5e91b`), B2 file version IDs recorded for the archive and the completion
marker, byte verification, and deletion by exact version. In the same run the two MinIO
destinations failed independently because their container was stopped, and the run reported
each delivery separately. Not covered: large transfers, B2 Object Lock, the offline CLI
against B2 (needs the secret). The owner was asked to delete the key afterwards.

## Final gates

Final tree, 2026-09-14 evening, all through `verify.sh`:

| Gate | Result |
| --- | --- |
| `workflow` | PASS (shell/Python syntax, agent definitions, helper regressions, lint, diff check); rerun after the last edit |
| `application` (`VITEST_MAX_WORKERS=2`) | PASS, `step.sxrWn3`: backup 44, API 2278, web 1852 tests; all coverage thresholds met |
| `integration` | PASS, `step.8bOT2w`: webdav 36, testkit 10, db 323, backup 2 (benchmark + S3), sftpgo 82, API 48 |
| `browser e2e/backups.spec.ts` | PASS, `step.lW4yLM`: 2 tests including health estimate, rehearsal upload and isolated restore; screenshots in `apps/web/test-results/` |
| API integration `backups.test.ts` | PASS again after the shared secret-codec refactor |

Earlier attempts on the way: the first `application` run failed on `desktop-effects` timeouts
under default worker concurrency; the second on a spool test whose one-shot `stat` mock was
consumed by another file (fixed by targeting the path); the third on API statements at
98.97% (fixed by sharing `masterSecrets` between module and CLI and covering the OCR mount
mapping branch). The first browser run failed on a strict text match once the health panel
also listed the destination name (spec now takes the first match).
