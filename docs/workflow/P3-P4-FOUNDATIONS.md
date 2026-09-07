# Phase 3 verification and Phase 4 foundations

Primary specification, 2026-09-06. User authorized autonomous completion of remaining
phases; configurable embeddings remain deferred. Phase 6 is explicitly unscheduled
and overlaps v1 non-goals; an optional scope question is pending while phases 3–5 proceed.

All workers read WORKING.md and PLAN.md §8/§13. Use their assigned absolute
worktree only. Never stash, change Git state, or delegate. Other workers are active;
preserve their changes. Prerequisites are copied from dirty main and recorded in a
parent-owned hash baseline. Reports distinguish new changes from prerequisites.

## P3-SFTP-RENAME, test-writer

Owned paths: `apps/api/test/integration/**` only. Add a disposable-container test
that renames a directory using the actual SFTP protocol, observes the real Python
indexer's filesystem event processing, and verifies the API listener moves tags,
favorites and recents within a bounded polling deadline. No synthetic database
NOTIFY or manually inserted move event may stand in for the rename. Include a
second identity and sibling path to assert scope and prefix boundaries. Use
test-local Docker/SSH helpers if needed; no production changes or new package
dependencies. Existing Docker CLI and system SSH tools are available. If an actual
production defect appears, report it with the failing test; do not weaken the test.
Fixtures must be isolated from dev containers/data. Clean resources on failure.

Run the new integration spec, API typecheck, and Biome on changed files. Tests use
bounded polling, not fixed sleeps. Report elapsed rename propagation, files,
commands and final output, gaps, branch and absolute checkout.

## P4-WOPI-CORE, implementer

Owned paths: `apps/api/src/office/protocol/**`, `apps/api/package.json`,
`pnpm-lock.yaml`. No routes, composition, config, core exports, or database edits.
Implement independently exported typed helpers and exhaustive unit tests:

- XML discovery parser using fast-xml-parser (pin compatible maintained version;
  reject DTD/entity declarations, malformed XML, unsafe action URL schemes).
  Parse actions by extension AND action name, plus current/old RSA public keys.
- Fill documented discovery placeholders (`ui`, `rs`, `thm`, `dchat`), remove
  unsupported placeholders, safely append encoded WOPISrc without corrupting query.
- Injectable discovery fetch/cache: 12-hour cache, bounded request timeout and
  response size, explicit refresh, concurrent refresh deduplication, no silent
  stale-key success after invalid documents. Configuration supplies trusted DS URL.
- Proof verifier: token UTF-8 length/value, uppercase full callback URL UTF-8
  length/value, big-endian 8-byte .NET ticks preceded by length 8; RSA-SHA256.
  Accept current proof/current key, old proof/current key, current proof/old key;
  never old proof/old key alone. Reject malformed headers/base64/timestamps,
  timestamps over 20 minutes old or over 5 minutes in future. Return typed validity
  including whether discovery refresh is advisable, no exceptions for bad input.
  URL is provided explicitly by trusted caller, never reconstructed from headers.
- Stable version helper from mtime, size and optional hash. No file-id or token
  design in this chunk; primary will specify durable cross-user file identifiers.

Sources: https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/scenarios/proofkeys
and https://api.onlyoffice.com/docs/docs-api/using-wopi/key-concepts/ . Consult
official vectors and XML examples, cite sources in comments where useful.
Run API typecheck, API unit coverage, Biome changed files. Cover rotation matrix,
Unicode lengths, timestamp boundaries, query preservation and view-before-edit.
Report public exports/interfaces, files, gate output, assumptions/gaps, branch/path.

## P4-WOPI-DB, implementer

Owned paths: `packages/db/src/repos/wopi-locks*.ts`,
`packages/db/src/repos/wopi-lock-state*.ts`, `packages/db/src/index.ts`,
`packages/db/test/integration/wopi-locks*.test.ts`, `packages/db/vitest.config.ts`.
Use existing app.wopi_locks; no schema/migration changes. Export standalone
`createWopiLockRepo(db)` and its types from db index; do not expand Repos.

Interface: `get(fileId, now): Promise<string | null>`;
`apply({fileId, operation, lockId, oldLockId?, now}): Promise<LockResult>`.
Operation union: lock, refresh, unlock, relock. LockResult discriminant `ok`;
failure contains currentLock (empty string means none). All successful lock,
refresh and relock operations expire at now plus 30 minutes. Expired entries are
absent. Lock absent creates; lock same refreshes; lock different conflicts.
Refresh/unlock require matching live lock. Relock requires matching oldLockId and
atomically replaces with lockId. Locks are not tied to users. Validate lock IDs
as ASCII 1–1024 bytes; file IDs nonempty and bounded; invalid input throws before IO.
Atomicity must work across processes, including absent rows: transaction-scoped
Postgres advisory lock on fileId, then read/mutate. Hash collisions may serialize
unrelated files but must not cause correctness issues. Pure transition function
and in-memory implementation share semantics; memory is for tests, never runtime.
Also expose `withFileLock<T>(fileId, callback)` holding that same transaction lock
across a caller's async check and storage operation. Callback receives bound
`get(now)` and `apply(inputWithoutFileId)` methods which reuse the transaction.
Public get/apply use this wrapper. Memory implementation serializes same-file
callbacks; release on exception. Integration tests prove another pool waits while
callback is active and lock releases/rolls back on throw. This prevents a save
checking a lock then racing with relock before its upload finishes.

IO repository may follow existing integration-only coverage exclusions; pure
state logic stays under full package coverage. Integration tests include two
independent pools concurrently acquiring absent lock, competing relocks,
expiry boundary, refresh, and wrong-lock no mutation. Run DB unit coverage,
typecheck, integration, Biome. Report API/types, files, gates, gaps, branch/path.
