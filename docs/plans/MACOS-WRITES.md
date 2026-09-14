# macOS write beta: remaining work

Updated 2026-09-14. Apache DAV native writes merged in PR #21. The optional pinned
SFTPGo integration merged in PR #22; full beta
qualification remains open. Current behavior: [macOS](../MACOS.md#write-configuration-and-recovery).
Storage requirements: [SFTPGo enforcement](../../integrations/sftpgo/README.md).
Delivery evidence: [handoff](../workflow/STATUS.md) and [history](../workflow/STATUS-history.md).
Search remains excluded.

## Safety boundary

The user chose **storage-side enforcement, with no optimistic fallback**. Stock SFTPGo
remains read-only. Qualified Apache DAV requires every writer to obey its exclusive locks.
The optional SFTPGo image fences local filesystem mutations across REST, SFTP, FTP and
WebDAV in one process. Direct host writers, writable service mounts and multiple SFTPGo
processes invalidate that qualification. Native virtual-folder identities and non-local
SFTPGo storage remain unsupported.

Keep explicit v2 write grants, staged uploads, retained originals, durable server receipts
and native pending copies. Publication followed by a crash before the receipt remains
uncertain until reconciled; never blindly replay it. No claim of exactly-once behavior
across HTTP, filesystem and PostgreSQL. A server item ID cannot prove every unobserved
external delete/recreate, particularly with identical bytes.

## Implementation still required

- **Retention and recovery administration.** Define retained receipt and backup lifetimes,
  inspect/export/reconcile uncertain operations, and reclaim only unreferenced acknowledged
  data. Protect active uploads and expired-operation retries. The current 64 GiB reservation
  ceiling refuses new writes; acknowledgements free incoming bytes but do not purge originals.
- **Deployment qualification.** Inventory every writer before enabling the optional SFTPGo
  image. Keep configuration, logs, databases, backups and temporary directories outside user
  homes. Qualify restart, upgrade and rollback against disposable data before production use.
  Server spool must be persistent and shared or durably routed in multi-process API setups.

## Product and release qualification

- Broader editor temporary-file cleanup. Recoverable Finder Trash and the app's **Restore
  from Trash** work; restoration targets the location's top level. Finder Put Back and
  permanent purge remain unavailable. Prove supported safe-save editors can operate with
  permanent-delete callbacks rejected; publish specific compatibility limits.
- Reboot, extension/API crash, low disk, large transfer and cross-domain cases below.
  Cross-domain copies can download then upload; advertise no atomic cross-domain move.
  Prove source preservation when the destination upload fails.
- Pending-aware Disconnect under callback races, expired credentials and revoked providers.
  Preserve/export unsynchronized content before removing a domain; never infer an empty
  journal from the framework's bounded pending-set enumeration alone.
- Upgrade the installed read-only app and existing catalogs without duplicate domains,
  identity changes or lost pending content. Explicit write permission upgrade, old/new
  protocol combinations and refusal to open newer schemas all need release rehearsal.
- Second-Mac installation, signing/notarization and distribution remain separate in
  [native beta qualification](MACOS-APP.md). Keep Actions disabled per the current handoff.

Deferred: delta/chunk-resumable uploads, remote search, automatic text merging, POSIX ACL
sync, general extended attributes/resource forks, synced Finder tags, symlinks/special files,
package-wide atomic commits, native permanent purge and optimized cross-domain transfers.
Do not promise support for arbitrary package documents or live databases.

## Acceptance and verification

- Through real Finder and disposable SFTPGo/WebDAV: create empty/nonempty files, drag a nested
  folder, save repeatedly in TextEdit and a safe-save editor, rename while saving, move a
  folder with downloaded children, conflict on destination, and restore from Trash.
- Use two independent clients plus the web app and an external storage writer: concurrent
  saves; same-size/same-mtime replacement; content edit versus rename/delete; changed parent;
  directory deletion versus new descendants. Preserve every unacknowledged local edit.
- Interrupt before/during upload, before commit, after upstream commit, after DB receipt and
  before native completion. Retry after extension/API restart and token rotation. No duplicate
  creates, wrong-target mutation, partial original or unverified destructive replay.
- Offline save/new-file/new-folder chains, network flapping, quota/low disk, denied parent,
  token expiry/revocation, provider disable, reconnect and Disconnect with pending work. Other
  locations continue working; failures explain how to recover.
- Upload a representative multi-gigabyte file; verify full-byte hash, bounded memory, progress,
  cancellation and staging cleanup. Refresh racing an upload never replaces its base or loses
  it. Plain directory enumeration still fetches no originals to the Mac.
- Upgrade the installed read-only app/catalog without duplicate domains or changed item IDs;
  upgrade permissions explicitly; test old/new protocol combinations and rollback refusal
  with a newer schema rather than catalog deletion. Rehearse reimport and pending edits.
- Exercise Unicode/percent names, case-only renames, existing collision rules, unsupported
  attributes and package documents. Publish specific compatibility limits for editors/packages
  that cannot meet their save semantics; no claim that an arbitrary live database is supported.

Use `tools/orchestration/verify.sh` for `application`, `integration`, affected `browser` tests
(including desktop approval) and `workflow`; use the merged `verify-macos.sh` for Swift tests
and native builds. Focus tests on recovery/state transitions and real backend behavior. Signed
Finder/editor tests supplement unit and API tests. Documentation-only planning runs `workflow`;
it does not establish that any native write or backend guarantee already works.

Apple API basis: [createItem](https://developer.apple.com/documentation/fileprovider/nsfileproviderreplicatedextension/createitem%28basedon%3Afields%3Acontents%3Aoptions%3Arequest%3Acompletionhandler%3A%29),
[modifyItem](https://developer.apple.com/documentation/fileprovider/nsfileproviderreplicatedextension/modifyitem%28_%3Abaseversion%3Achangedfields%3Acontents%3Aoptions%3Arequest%3Acompletionhandler%3A%29),
[deleteItem](https://developer.apple.com/documentation/fileprovider/nsfileproviderreplicatedextension/deleteitem%28identifier%3Abaseversion%3Aoptions%3Arequest%3Acompletionhandler%3A%29)
and [synchronization](https://developer.apple.com/documentation/fileprovider/synchronizing-the-file-provider-extension).
Callback ownership, combined filename/content updates, replay, pending-set limits and deletion
semantics were also checked in the installed Xcode SDK's `NSFileProviderReplicatedExtension.h`.
