# Native writes on stock storage

Updated 2026-09-16. Outcome: Finder create/update/move/trash/restore works against
**unmodified** SFTPGo. The forked image and its `fdrive-local-v1` mode were removed on
2026-09-16, so this is now the only SFTPGo write contract. Current behavior: since 2026-09-18 this
is the default contract for every storage (`publishesSafely` in
`apps/api/src/desktop/publish-gate.ts` accepts any storage once the publish lock is configured);
the `verified-optimistic` selector was removed, S3 publishes the same way, and a stale value in a
stored row is ignored. Related:
[macOS writes](MACOS-WRITES.md), [macOS behavior](../MACOS.md#write-configuration-and-recovery),
[provider development](../STORAGE-PROVIDERS.md).

## Accepted decision

The user accepts a bounded lost-update window for writers fdrive does not mediate, in exchange
for writes on the storage users actually run. This supersedes the "storage-side enforcement,
with no optimistic fallback" clause in [macOS writes](MACOS-WRITES.md) **for SFTPGo**.
`apache-webdav-exclusive` keeps its existing stronger guarantee and its existing behavior;
nothing about that mode changes.

What motivated it: `deploy/compose.yaml:312` mounts the storage root into OCR read-write (the
indexer at `:264` is `:ro`), and `services/ocr/src/fdrive_ocr/restore.py:483` replaces files in
place at user paths. The forked image's lease hooked `internal/vfs/osfs.go`, beneath SFTPGo's
protocols, so it could not observe a process writing the volume directly. The strict guarantee was
therefore already
void in the default deployment, which is what moves coordination to the fdrive layer, where
every fdrive writer is reachable, and leaves optimistic verification for genuinely external ones.

## Delivered

**1. Desktop commits are serialized against each other.** `createDesktopPublishLock` in
`packages/db/src/repos/desktop-publish-lock.ts` takes a *session* advisory lock on a connection
from its own pool, keyed `["desktop-publish", identityId]`, held across the publication step.
A session lock rather than the registry's `pg_advisory_xact_lock` because the critical section
is storage round trips rather than database work, and an open transaction would pin a backend
for their duration; the backend releases it when the connection dies, so a crashed API process
frees the identity without operator action. Acquisition is bounded (30s default) and reports
`DesktopPublishBusyError`, which the commit path turns into `rate_limited`. Contention is not a
conflict — nothing changed remotely and the same request succeeds once the holder finishes — so
it must not reach the client as a 409, which `APIClient.check` turns into
`DriveError.writeConflict` and `Writes.swift` resolves by forking the pending bytes into a
conflict copy. A 429 with no details code reaches `DriveError.unavailable`, which File Provider
retries.

It fences desktop commits and nothing else. Web mutations (`apps/api/src/fs/routes.ts`),
Collabora saves (`apps/api/src/office/writes.ts`), the retention job and the OCR pass never take
it, and could not cheaply: their publication *is* their transfer, and holding an identity across
a transfer is what this design exists to avoid. A desktop commit is not exposed to them, because
item 2 proves the destination's content rather than trusting the lock to have excluded everyone.

**2. The destination's content is proven inside the serialized section.** For a replace-upload,
`apps/api/src/desktop/writes.ts` takes the recovery copy *inside* the section and digests it
against the client's base version. A copy is a snapshot, so a digest matching the base proves
the destination still held that content at the moment of the copy — and the copy happened under
the lock, so no other desktop commit can have written between the proof and the rename. On a
retry the copy is retained from the earlier attempt and records what the destination held
*then*, so that case digests the live file directly instead. This costs no extra I/O: the digest
already ran, just outside the section.

`unchanged` still runs, and is the whole guard for moves, which carry no content to digest. It
compares the destination's size and modification time against an observation taken once,
immediately after the base check. It cannot be the guard for content: `statFile` on SFTPGo is a
HEAD whose `Last-Modified` is an HTTP date, so its resolution is a whole second, and two writers
replacing one file with equal-length content inside that second are indistinguishable to it.
Re-stating the observation closer to the rename would narrow its window to nothing, because the
fresh stat would adopt whatever another writer had just written; `optimistic-publish.test.ts`
pins that with a regression test firing a write the instant the recovery copy is taken.

**3. `verified-optimistic` is selectable on stock SFTPGo** (superseded 2026-09-18: it is the default for every storage and no longer selectable). The capability gate moved off
`storage.withWriteLease` onto `publishesSafely` in `apps/api/src/desktop/publish-gate.ts`, which
accepts either a lease or `optimisticPublish` **together with** a configured publish lock — a
deployment without the lock stays read-only instead of publishing unserialized.

**4. Documentation.** `docs/MACOS.md#write-configuration-and-recovery` carries the three modes
and what each actually guarantees.

**5. The lock is isolated from the API's connection pool.** It runs on its own bounded pool and
is taken for the publication step only, never for the transfer, and not at all when the storage
enforces a lease. See [Connection pressure on the publish lock](#connection-pressure-on-the-publish-lock).

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

A write to the same path landing between the recovery copy that proves the destination and the
rename that replaces it is silently lost, and the retained `previous` holds pre-fdrive content
rather than the lost version. That window is the few storage round trips inside the serialized
section, and it is open to every writer that does not take the publish lock: a direct SFTP, FTP
or WebDAV client, but also fdrive's own web uploads, Collabora saves and the OCR pass, which are
listed in item 1 as deliberately outside it. Items 1, 2 and the detection proposal shrink and
surface it; only a VFS hook inside SFTPGo, which the removed forked image provided, eliminates
it. Document this in the mode's help text and in MACOS.md; do not describe the stock path as
conflict-proof anywhere.

## Verified

- `apps/api/test/integration/desktop-writes-stock.test.ts` drives real unmodified SFTPGo
  end to end on one instance: create, replace, and refusal of an out-of-band WebDAV write with
  the external content left intact. The existing lease test still passes on Apache DAV, so
  nothing about `apache-webdav-exclusive` changed.
- `packages/db/test/integration/desktop-publish-lock.test.ts` proves mutual exclusion, a bounded
  wait reporting `DesktopPublishBusyError`, independence between identities, and release on a
  throwing callback, against real PostgreSQL on independent pools.
- `apps/api/src/desktop/optimistic-publish.test.ts` covers the gate, the read-only fallback when
  no lock is configured, busy contention, and the recheck at both of its windows. Both recheck
  tests were confirmed by mutation: disabling `unchanged` fails the first, so it is not passing
  through `checkBase`, and re-stating the witness just before the rename fails the second.
- Package suites all pass run individually: api coverage 99.01% over 2344 tests, db 257, core
  364, sftpgo 38, plus db and backup integration.

Not yet done: the `application` and `integration` profiles have not passed as a whole. Each run
fails on a different timing-sensitive test that passes in isolation (`recycle-folder-trash`,
`wopi-locks`, `desktop-effects`, `backup/benchmark`), which is Docker and CPU contention rather
than a regression. Re-run both profiles on an otherwise idle machine before treating this as
green.

## Connection pressure on the publish lock

Serializing publication must not let desktop writes consume the database pool the rest of the
API depends on. Three changes, with the behavior that motivated them.

### What it used to do

`createDesktopPublishLock(pool)` in `apps/api/src/composition.ts` uses the one pool
`createDb` builds at `composition.ts:160`. That call passes no `max`, so node-postgres
defaults to **10** connections, and no `connectionTimeoutMillis`, so a caller waiting for a
connection waits forever. `drizzle(pool)` runs on the same pool, so every repo query in the API
competes for those 10.

The lock takes a dedicated connection and holds it for the entire `publish()` callback in
`apps/api/src/desktop/writes.ts`. That callback contains the staged upload
(`writes.ts:679`, capped at `DESKTOP_MAX_UPLOAD_BYTES` = 16 GiB), the staged digest, the
recovery copy and the recovery digest. The critical section is therefore as long as the
transfer, not the "several storage round trips" the doc comment on
`packages/db/src/repos/desktop-publish-lock.ts` claims. Three consequences:

- **Pool starvation.** Ten concurrent desktop uploads hold all ten connections for the length
  of their transfers. Every unrelated query in the API blocks, with no timeout.
- **Re-entrancy hazard.** The lock holder does its own database work *while holding a
  connection*: `transition` at `writes.ts:672`, `repo.captureEffects`, `repo.move` and
  `repo.complete`. Under exhaustion a holder needs a second connection to finish and cannot
  get one, so it cannot release the first. Waiters do eventually give up on the 30s deadline
  and free theirs, so this unwedges rather than hanging permanently — but sustained write load
  keeps it wedged, and an exhaustion caused by other traffic has no such bound.
- **Spurious contention.** Waiters also hold a connection for up to 30s while polling. With
  the critical section spanning whole transfers, two concurrent large saves by one user can
  exceed the deadline and report busy for no good reason.

### What changed

**Do not take the lock when the provider enforces a lease.** A lease implementation already
serializes every fdrive writer: `withWebdavWriteLease` holds a `Depth: infinity` exclusive
`LOCK` on the endpoint root, renewed every 20s for the length of the action (the removed
`withSftpgoWriteLease` held an exclusive per-user lease from the forked image the same way). The
fdrive lock adds nothing there but the connection cost. Making `publish()` take the lock only on
the leaseless path removes the pool pressure from `apache-webdav-exclusive` entirely, and
disposes of the lock-before-lease ordering constraint rather than merely documenting it.

**Narrow the critical section to publication.** `publish()` no longer wraps the body; it hands
it a `serialize` that each branch wraps around its own publication step — the recheck, the
rename, and the recovery rename that follows it. Everything before that writes only to
`${DESKTOP_INTERNAL_ROOT}/${identityId}/${id}/${remoteAttempt}`, a path keyed by operation id
and a per-attempt UUID that no other operation can reach, so serializing the transfer bought
nothing. The witness stat stays outside the lock: a write by another fdrive writer between the
stat and the lock is exactly what the recheck inside the lock is for. The receipt commit stays
outside it too — a concurrent publication between the rename and the receipt is refused by that
writer's own recheck, so holding the identity across database work would only reintroduce the
re-entrancy hazard.

That moved name resolution out of the serialized region, which needed handling. `unoccupied()`
(`writes.ts:258`) refuses a name that is already taken; run outside serialization, two writers
creating the same new name both find it free. Stock SFTPGo's REST rename ignores
`overwrite: false`, so without more the loser would silently replace the winner; the provider now
emulates the refusal with a stat before every guarded upload, move and copy (`withOverwriteGuard`
in `packages/sftpgo/src/write-lease.ts`), which is exact under the lock for desktop writers and
best-effort against anyone outside it. Publication also re-checks the name inside the critical
section, one `list` call of the parent, skipped under a lease, so the loser gets
`name_collision`, which `Writes.swift:140` resolves with a bounded numbered retry.

**Bound what the lock can consume.** The lock now gets its own pool: `createPool` in
`packages/db/src/index.ts`, wired in `composition.ts` with `max: 4` and a 5s
`connectionTimeoutMillis`. A failure to check out a connection becomes `DesktopPublishBusyError`
with the cause attached, because publication has not started and the caller can retry — the
alternative, on an unbounded pool, is queueing forever. `CreateDbOptions` grew
`connectionTimeoutMillis` alongside the existing `max`.

The alternative considered and not taken: a `desktop_publish_lease` row per identity, taken and
released in ordinary short transactions and expiring on a TTL, which holds no connection at all.
It costs a migration and trades recovery-on-connection-death for recovery-on-TTL-expiry. Worth
revisiting only if holding a connection for the narrowed critical section proves to matter.

Still open, unrelated to the lock: `createDb` has no configurable `max` at the call site in
`composition.ts:160`, so the main pool is still node-postgres' default of 10. That is a low
ceiling for an API also serving web sessions. Proposal, not a requirement of this work.

### Verified

- `optimistic-publish.test.ts` covers all three: a leased provider never calls the lock, the
  staged upload and the recovery copy both complete before the identity is taken, and a name
  taken between resolution and publication is refused as `name_collision`. All three were
  confirmed by mutation — restoring the old `publish()` fails the first two, dropping the
  in-section recheck fails the third.
- `desktop-publish-lock.test.ts` adds a saturated bounded pool and asserts it reports busy
  rather than queueing, against real PostgreSQL.
- Real-storage integration passes unchanged on stock SFTPGo and on both leased backends, so the
  narrowed critical section publishes the same way it did.

Not covered by a test: that concurrent uploads no longer delay unrelated queries. The isolated
pool makes that structural rather than behavioral, and a load test asserting it would be timing
dependent.

## What the narrowing cost, and how it was taken back

Narrowing the critical section to publication moved `checkBase` out of it. That was a real loss,
not a wash, and review caught it after the fact.

### What it used to do

With the lock spanning the whole callback, two desktop commits on one file were separated by a
content digest: the loser's `checkBase` ran *after* the winner's rename and failed against the
client's base hash, deterministically. Narrowed, both commits digest the old bytes concurrently
and both pass, and the only remaining guard is `unchanged` — a size and a `Last-Modified` header
SFTPGo reports to the second. Two writers replacing one file with equal-length content inside
that second both publish, and the second silently overwrites the first.

### What changed

**The recovery copy is taken inside the section.** The copy is a snapshot, so digesting it
against the client's base proves the destination's content at the moment of the copy; taking it
under the lock means nothing that honours the lock wrote between the proof and the rename. The
digest already existed — it just ran outside — so the operation performs the same I/O and only
the lock hold grows, by one server-side copy plus a read of the file being replaced.

A copy retained from an earlier attempt is explicitly not accepted as proof: it records what the
destination held during *that* attempt. When one is found, the live destination is digested
directly instead.

**A failed recovery digest is now a conflict.** It used to raise a bare `Error`, which left the
operation `ready` and invited the client to retry against a base that could never match again.
It is the fdrive-versus-fdrive conflict detector now, so it reports `version_conflict`.

**Waiters release their connection between polls.** A session lock has to be taken and released
on one connection, but waiting for one owns nothing. Holding it across the wait made the pool's
`max: 4` bound cover waiters as well as holders, so one slow identity could refuse publication to
every other identity in the deployment.

**The lock's documentation no longer claims what it does not do.** It said it fenced "every
writer fdrive mediates — desktop commits, web mutations, the retention job and the OCR pass".
Only desktop commits take it. The correction is in the type's doc comment, in item 1 above, and
in the residual-risk section, which now names fdrive's own unfenced writers alongside external
ones.

### Verified

- `optimistic-publish.test.ts` gained four cases, each confirmed by mutation: a same-size
  replacement the stat cannot see (fails if the copy moves back outside the section), a retained
  copy from an interrupted attempt (fails if the live digest is dropped), and the folder and move
  branches' name recheck (each fails if its own `resolveTarget()` is dropped). The lock-scope
  test now pins `copiesFirst === 0` alongside `uploadsFirst === 1`.
- `desktop-publish-lock.test.ts` adds a pool bounded to two where a third identity acquires while
  a waiter polls. Restoring the hold-across-poll loop fails it with `DesktopPublishBusyError`.

Not taken: making the web, Collabora and OCR paths take the lock. Their publication is their
transfer, so serializing it would hold an identity for the length of an upload — the cost this
design removed. Proving the destination inside the section protects the desktop commit from them
without that.

## Acceptance and verification

Extend the existing matrix in [macOS writes](MACOS-WRITES.md) rather than restating it.
Specific to this work:

- `apps/api/test/integration/desktop-writes.test.ts` covers `apache-webdav-exclusive`; stock
  SFTPGo with no lease is covered by `desktop-writes-stock.test.ts` and holds every existing
  assertion.
- Concurrency, against real disposable SFTPGo: two fdrive writers to one path serialize; an OCR
  restore racing a desktop commit serializes; an external write landing before the final stat is
  refused with `version_conflict` and the pending copy survives.
- Real Finder against stock SFTPGo: repeated saves in TextEdit and a safe-save editor, rename
  while saving, destination conflict, folder move with downloaded children, Trash and restore.
- Interrupt before upload, before commit, after upstream commit and after the database receipt.
  No duplicate creates, wrong-target mutation, partial original or unverified destructive replay.

Profiles: `application` and `integration`; affected `browser` tests for the provider settings
field; `python ocr` for the lock participation; `workflow` for this document.
