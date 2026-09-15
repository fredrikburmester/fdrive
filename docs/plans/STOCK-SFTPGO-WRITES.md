# Native writes on stock storage

Updated 2026-09-15. Outcome: Finder create/update/move/trash/restore works against
**unmodified** SFTPGo, without the forked image. Current behavior: stock SFTPGo is read-only
from the Mac (`packages/sftpgo/src/module.ts` returns storage without `withWriteLease`, so
`capabilities()` in `apps/api/src/desktop/writes.ts` yields `NO_WRITES`). Related:
[macOS writes](MACOS-WRITES.md), [macOS behavior](../MACOS.md#write-configuration-and-recovery),
[provider development](../STORAGE-PROVIDERS.md).

## Accepted decision

The user accepts a bounded lost-update window for writers fdrive does not mediate, in exchange
for writes on the storage users actually run. This supersedes the "storage-side enforcement,
with no optimistic fallback" clause in [macOS writes](MACOS-WRITES.md) **for the stock path
only**. `fdrive-local-v1` and `apache-webdav-exclusive` keep their existing stronger guarantee
and their existing behavior; nothing about those modes changes.

What motivated it: `deploy/compose.yaml:312` mounts the storage root into OCR read-write (the
indexer at `:264` is `:ro`), and `services/ocr/src/fdrive_ocr/restore.py:483` replaces files in
place at user paths. The lease hooks `internal/vfs/osfs.go`, beneath SFTPGo's protocols, so it
cannot observe a process writing the volume directly. The strict guarantee is therefore already
void in the default deployment, which is what moves coordination to the fdrive layer, where
every fdrive writer is reachable, and leaves optimistic verification for genuinely external ones.

## Delivered

**1. fdrive's own writers are serialized.** `createDesktopPublishLock` in
`packages/db/src/repos/desktop-publish-lock.ts` takes a *session* advisory lock on a dedicated
pooled connection, keyed `["desktop-publish", identityId]`, held across the whole publication.
A session lock rather than the registry's `pg_advisory_xact_lock` because publication spans
several storage round trips and an open transaction would pin a backend for the length of a
transfer; the backend releases it when the connection dies, so a crashed API process frees the
identity without operator action. Acquisition is bounded (30s default) and reports
`DesktopPublishBusyError`, which the commit path turns into an unclassified 409 — already
handled by the Mac client as a retryable write conflict that preserves the pending copy.

**2. The destination is rechecked immediately before publication.** `unchanged` in
`apps/api/src/desktop/writes.ts` compares the destination's size and modification time against
the observation the content verification was based on, and fails `version_conflict` on any
difference. It is a stat, not a re-digest, so it cannot see a same-size replacement inside one
mtime tick.

**3. `verified-optimistic` is selectable on stock SFTPGo.** The capability gate moved off
`storage.withWriteLease` onto `publishesSafely` in `apps/api/src/desktop/publish-gate.ts`, which
accepts either a lease or `optimisticPublish` **together with** a configured publish lock — a
deployment without the lock stays read-only instead of publishing unserialized.

**4. Documentation.** `docs/MACOS.md#write-configuration-and-recovery` carries the three modes
and what each actually guarantees.

## Not delivered

**OCR does not share the serialization.** The plan assumed OCR could take the same lock. It
cannot as written: OCR works in `(root_id, path)` space and has no identity concept, and it
already holds its own advisory lock on that key (`services/ocr/src/fdrive_ocr/db.py`,
`ocr_file_lock`). A shared gate needs one key space, which means plumbing the
`FDRIVE_INDEX_ROOTS` path mapping into the desktop write path — real cross-service work, not a
line change. It is less urgent than it looks: OCR's replace changes size and mtime, so the
recheck in item 2 refuses the publication, and OCR's own `classify_state` refuses on
`STATE_CHANGED` in the other direction. A collision is detected on both sides rather than
silently applied; it is simply not prevented. Narrowing OCR's read-write mount at
`deploy/compose.yaml:312` is the other half of this question and is still open.

## Proposal, not a commitment

**Uncertain-publication detection.** The indexer already watches the same roots over inotify.
Recording the publish window would let it report a modification to the target inside that window,
marking the operation uncertain and exempting its `previous` copy from retention reclaim. This is
detection after the fact; it does not close the window and is not required to ship writes.

## Accepted residual risk

A direct SFTP, FTP or WebDAV write to the same path inside the window between the final stat and
the rename is silently lost, and the retained `previous` holds pre-fdrive content rather than the
lost version. Items 1, 2 and the detection proposal shrink and surface it; only the VFS hook in
the forked image eliminates it. Document this in the mode's help text and in MACOS.md; do not
describe the stock path as conflict-proof anywhere.

## Verified

- `apps/api/test/integration/desktop-writes-stock.test.ts` drives real unmodified SFTPGo
  end to end on one instance: create, replace, and refusal of an out-of-band WebDAV write with
  the external content left intact. The existing lease test still passes on both qualified
  backends, so nothing about `fdrive-local-v1` or `apache-webdav-exclusive` changed.
- `packages/db/test/integration/desktop-publish-lock.test.ts` proves mutual exclusion, a bounded
  wait reporting `DesktopPublishBusyError`, independence between identities, and release on a
  throwing callback, against real PostgreSQL on independent pools.
- `apps/api/src/desktop/optimistic-publish.test.ts` covers the gate, the read-only fallback when
  no lock is configured, busy contention, and the recheck itself. The recheck test was confirmed
  by mutation: disabling `unchanged` makes it fail, so it is not passing through `checkBase`.
- Package suites all pass run individually: api coverage 99.01% over 2340 tests, db 257, core
  364, sftpgo 38, plus db and backup integration.

Not yet done: the `application` and `integration` profiles have not passed as a whole. Each run
fails on a different timing-sensitive test that passes in isolation (`recycle-folder-trash`,
`wopi-locks`, `desktop-effects`, `backup/benchmark`), which is Docker and CPU contention rather
than a regression. Re-run both profiles on an otherwise idle machine before treating this as
green.

## Acceptance and verification

Extend the existing matrix in [macOS writes](MACOS-WRITES.md) rather than restating it.
Specific to this work:

- `apps/api/test/integration/desktop-writes.test.ts` runs a `qualified` matrix of
  `fdrive-local-v1` and `apache-webdav-exclusive`; add stock SFTPGo with no lease as a third
  backend and hold every existing assertion.
- Concurrency, against real disposable SFTPGo: two fdrive writers to one path serialize; an OCR
  restore racing a desktop commit serializes; an external write landing before the final stat is
  refused with `version_conflict` and the pending copy survives.
- Real Finder against stock SFTPGo: repeated saves in TextEdit and a safe-save editor, rename
  while saving, destination conflict, folder move with downloaded children, Trash and restore.
- Interrupt before upload, before commit, after upstream commit and after the database receipt.
  No duplicate creates, wrong-target mutation, partial original or unverified destructive replay.

Profiles: `application` and `integration`; affected `browser` tests for the provider settings
field; `python ocr` for the lock participation; `workflow` for this document.
