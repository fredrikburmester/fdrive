# macOS write support

Status: qualified DAV implementation complete; full beta qualification open, 2026-09-14,
in `/private/tmp/fdrive-macos-writes`
(branch `codex/macos-writes`). Search remains excluded.

## Safety decision and measured backend gate

The user requested the safest option after the conditional-write proof: **require storage-side
enforcement; no optimistic SFTPGo fallback**. Current SFTPGo remains read-only until it can
provide enforcement across every writer. This is an unresolved part of the original target,
not a completed two-provider beta. Continue the safe native/API/recovery implementation.

Disposable backend evidence (`.fdrive-workflow/evaluation/provider-write-proof.json`):
SFTPGo 2.7.5 returns 201 and overwrites for both `If-None-Match: *` and a stale `If-Match`;
Apache returns 412 and preserves the original. Cross-protocol testing also proves SFTPGo's
WebDAV lock does not stop a REST upload (201, changed bytes).

Apache proof (`provider-lock-proof.json`): root exclusive lock 200; outside PUT blocked 423;
exclusive staging PUT 201; lease-fenced MOVE publication 204; unlock 204; stale lease PUT 412,
completed bytes preserved. A root-only tagged `If` is insufficient for fencing an existing
resource after unlock. Final updates must include the source/destination resource conditions.
Qualify only Apache WebDAV configurations in which every writer obeys the same locks; direct
filesystem/SFTP writers invalidate that prerequisite. A bare WebDAV provider is not enough.

## Current implementation and outstanding acceptance

Implemented in `codex/macos-writes`: v2 grants, qualified Apache DAV publication, server
operation/item persistence, native immutable recovery copies, create/save/move callbacks,
offline retry and conflict copies. See [current behavior](../MACOS.md#write-configuration-and-recovery).
Real signed Finder/TextEdit save, creation, folder, rename/move, offline and conflict cases pass.
Application checks, integration, affected browser and 26 Swift tests/native build pass. The isolated
signed build/signature and workflow checks pass.

Still unfinished before the full write beta can be called ready:

- SFTPGo enforcement across all writers. No optimistic fallback is authorized.
- Broader editor temporary-file cleanup qualification. Recoverable Finder Trash/restore is
  implemented following explicit user approval. Permanent-delete callbacks still reject;
  the app's Restore from Trash action returns items to the location's top level. Finder Put Back
  is unavailable. Signed native recovery verified files, nested/empty folders and reconnect.
- Durable metadata-effect outbox. A failure after publication remains uncertain, preserving
  all copies and preventing blind replay, rather than automatically completing metadata effects.
- Backup retention/reclamation and recovery administration. The current 64 GiB reservation
  ceiling fails closed; acknowledgement frees incoming bytes but never purges retained originals.
- Wider safe-save editors, package/resource-fork behavior, reboot/low-disk/large-transfer and
  cross-domain acceptance below. These are qualification requirements, not passed claims.

## Baseline

Build on the existing native client, merged in [PR #19](https://github.com/fredrikburmester/fdrive-web/pull/19),
and signed distribution from [PR #20](https://github.com/fredrikburmester/fdrive-web/pull/20).
Source reviewed at `origin/main` commit `c16cebef40a2d2e83111f4e2997a88ad48d79565`.
The assigned checkout predates those merges; source was inspected through Git without
merging over its existing documentation changes. Implementation must start from current main.

Already implemented: macOS 26+/Apple silicon, SwiftUI app, replicated File Provider,
identity-specific pairing/credentials, Finder domains, SQLite catalog v2, lazy downloads,
materialized-file validation, refresh/backoff and signed installation. Keep these foundations.
Existing beta qualification remains separate from write acceptance.

Verified changes needed:

| Current code on the reviewed commit | Required extension |
| --- | --- |
| `Extension/FileProviderExtension.swift` rejects create/delete and content/name/parent changes | Implement mutations and replay handling; retain harmless local bookkeeping |
| `Extension/ProviderItem.swift` supplies read-only capabilities and filesystem flags | Derive writable capabilities from current server authorization and backend support |
| `FdriveKit/APIClient.swift` and `App/FdriveApp.swift` require protocol 1 and `readOnly` | Negotiate writes without breaking installed read-only clients |
| `FdriveKit/Catalog.swift` tracks remote snapshots by path; IDs survive metadata edits, not moves | Preserve IDs during acknowledged moves; retain pending edits through refresh and restart |
| `FdriveKit/Refresh.swift` validates materialized content without pending-write state | Reconcile against the last synchronized base separately from local changes |
| `apps/api/src/desktop/{routes,files,pairing}.ts` only admit/issue read tokens | Add explicitly approved write grants and independently guarded mutation routes |
| `packages/core/src/ports/storage.ts` has uploads/moves/deletes, no conditional replacement contract | Add tested conditional publication and source/destination preconditions |
| WebDAV sends `If-None-Match: *` on exclusive upload and `Overwrite: F` on move | Expose strong validators and prove replacement/rename semantics on supported servers |
| SFTPGo adapter does not enforce `overwrite: false`; existing target checks race other writers | Establish an upstream-enforced commit strategy before enabling its affected writes |

Native paths above are relative to `apps/macos/`. [Reviewed source tree](https://github.com/fredrikburmester/fdrive-web/tree/c16cebef40a2d2e83111f4e2997a88ad48d79565/apps/macos)
and [current architecture at that commit](https://github.com/fredrikburmester/fdrive-web/blob/c16cebef40a2d2e83111f4e2997a88ad48d79565/docs/MACOS.md).

## Intended behavior

- Save an existing file in its ordinary editor; drag in files/folders; create new files/folders.
- Rename and move within a location while preserving item identity and cached descendants.
- Edit downloaded files while offline. Finder retains pending changes and synchronizes on
  reconnect. New files can wait for their parent to synchronize.
- Show uploading, pending, conflict, permission and quota failures per location/item. A local
  editor's Save does not imply that remote synchronization has finished.
- Preserve both versions when independent edits conflict. Default resolution is a separate
  conflict copy; replacing the remote file requires an explicit user choice and a fresh check.
- Add recoverable Finder Trash/restore after save and organization behavior is proven.
  Never silently turn Move to Trash into permanent removal when Trash is unavailable.

First deliverable: new-file upload plus existing-file save through the real signed extension
and real fdrive API. Complete the sequence below before calling the full write feature ready.
Folder uploads are a series of item operations, not an atomic directory transaction.

Deferred: delta/chunk-resumable uploads, remote search, collaboration/automatic text merging,
POSIX ownership/ACL sync, general extended attributes/resource forks, Finder tags synced to
fdrive tags, symlinks/special files, package-wide atomic commits, native Empty Trash/permanent
purge, and optimized transfers between domains. Ordinary cross-domain Finder copies may
download then upload; advertise no atomic cross-domain move. Prove source preservation on
failed destination uploads before documenting any cross-domain move as supported.

## Backend correctness gate

Do this first, using disposable SFTPGo and the real WebDAV fixtures. The current SHA-256
refresh detects changed bytes but is not a conditional write. A stat/hash followed by upload
can overwrite a change made between the two calls. A PostgreSQL lock only coordinates
participating fdrive processes; it cannot exclude SFTP, WebDAV, Office or host-side writers.

Extend the storage boundary with explicit capabilities for exclusive creation, conditional
content replacement, guarded move and recoverable removal. Define results with canonical
metadata, a content validator and the guarantees actually provided. Require:

1. No partially uploaded replacement becomes the visible original after interruption.
2. A changed source/base or occupied destination cannot be silently overwritten.
3. Preconditions apply at upstream commit, not just during fdrive admission.
4. A lost response can be reconciled without blindly replaying a destructive operation.

For WebDAV, investigate strong ETags, conditional PUT/MOVE and, where necessary, compliant
locking/staging. `atomicMove: true` alone does not establish conditional replacement, and
plain PUT does not prove atomic visibility on every server. Probe the actual supported
configuration; a generic WebDAV label is insufficient.

For SFTPGo, test the configured storage backend's upload publication behavior and user API
preconditions. The current adapter offers neither a common strong validator nor enforced
exclusive upload/move. If its user API lacks the required primitives, implement a suitable
provider integration before enabling those capabilities. Do not silently change the Mac to
connect directly to SFTP or pretend a local mutex solves external races. Record the concrete
supported backend/configuration and remaining engineering at this gate, then update effort.

Unsupported operations remain unavailable with a visible reason. A write beta targeting both
providers is incomplete until both pass their relevant guarantees. Destructive operations on
directory trees need their own proof; a file ETag does not version all descendants.

## Authorization and protocol

Introduce desktop protocol 2 under `/api/v2/desktop`; retain protocol 1 and its exact read-only
behavior. The installed app rejects writable protocol-1 locations, so flipping `readOnly`
in the existing response would break it.

- Reuse browser pairing, the `fdd_` audience, token ownership checks and revocation storage.
  Pairing explicitly selects Read or Read and write per identity. Existing credentials retain
  read access. Upgrading a location issues an approved replacement credential without changing
  its domain, App Group, Keychain group or local item IDs.
- Return protocol, granted operations, backend-supported operations and transfer limits.
  Capabilities are their intersection; storage permissions remain authoritative on each call.
  Refresh/reconnect updates cached capabilities and signals Finder when permissions change.
- Reuse token `full` mode only behind the desktop audience and route policy; never make an
  MCP token a desktop credential or grant browser-session write access to desktop routes.
- Validate identity, provider enabled state, current grants, canonical source/destination and
  ancestors at commit as well as upload initiation. Reject root mutation, escaping names,
  symlink traversal, moves into descendants and direct access to internal staging/Trash paths.
- Recheck both parents on moves. Readable ancestors outside a folder grant are not writable.
  Opaque item/operation/upload IDs never authorize access themselves.
- New clients fall back to read-only v1 on old servers. Server-first deployment, app upgrade
  and credential upgrade are distinct steps. Test old app/new server and new app/old server.

Suggested v2 contract, with typed schemas in `packages/contracts`:

| Operation | Contract |
| --- | --- |
| Location, listing, stat and content | Existing read behavior plus item handles, versions and capabilities |
| Begin upload | Idempotency key, parent/item handle, filename, expected base, length and SHA-256; returns upload ID |
| Upload bytes | Stream a file body to that upload ID; cancellation, limits, length and digest checks |
| Commit upload | Publish only fully received bytes with upstream-enforced preconditions; canonical item/version receipt |
| Create folder | Idempotent creation under an authorized parent; collision never means success for someone else's folder |
| Modify item | Changed fields, source base and destination preconditions; supports combined name/content changes |
| Operation status/cancel | Durable receipt or pending/uncertain state; cancel cannot claim to undo a completed commit |
| Trash/restore | Item/base plus a recovery handle; no permanent fallback or raw recycle-path access |

Split upload transfer from commit to recover a dropped response without resending published
bytes. Start with restart-from-zero transfer after an incomplete body; byte-range resume is
not required. Server staging must be durable across process restart, quota bounded, expired
and garbage-collected only when unreferenced. In multi-process deployment it must be shared
or durably owned/routed. Final upstream publication still needs the backend gate above.

## Identity, versions and operation recovery

Retain current local UUIDs. Add a lazily populated server item registry for tracked items,
scoped to identity, and store its handle alongside each local ID. No whole-tree registry scan
or general server change-feed project is required. Preserve handles for known fdrive moves;
unmatched external moves remain removal/addition, as in the existing client.

Store separate last-synchronized content and metadata bases. A random catalog revision or
size/mtime is not a content validator. Bind content bases to the bytes actually downloaded
and to a validator the backend can enforce. Filename/parent changes must not manufacture a
new content base. Preserve the existing same-size/same-mtime detection.

Path-only storage still cannot prove every unobserved external delete/recreate, especially
with identical bytes. A server-assigned ID does not create that upstream guarantee. Do not
guess a new path for an offline edit using a filename/hash match. Retain the edit and surface
a conflict when identity or source continuity is uncertain.

Add a durable server operation ledger in PostgreSQL and an operation journal in catalog v3:

- Record operation ID, domain/identity/device, local/template item ID, server handle, base,
  changed fields, destination, content digest/length and outcome. No secrets or contents in logs.
- Map Apple's stable create-template ID to one generated provider ID and server operation.
  Modification keys also include the local edit generation/body identity; a later save must
  never reuse an earlier operation just because its item/base matches.
- Serialize conflicting item/parent/subtree operations across processes, in deterministic
  order. Do not hold a database transaction open for the duration of a large upload.
- Commit the canonical catalog update before completing the native callback. Replayed
  callbacks return the recorded result; reconnect can recover the same operation under a
  rotated credential only after verifying the same account/identity and current grants.
- Treat an upstream success followed by a crash before the DB receipt as uncertain. Reconcile
  using backend evidence/operation staging; if it cannot be proven, retain the pending edit
  and surface recovery. Never claim exactly-once behavior across HTTP and PostgreSQL.
- Define retention and expired-operation behavior. An old retry outside retained history
  requires reconciliation, not a fresh execution. Janitors cannot delete active upload state.

Route desktop changes through shared file-mutation effects: tags/favorites/recent paths,
folder views, Office identity and relevant storage/index events. Extract existing hooks from
`apps/api/src/fs` where needed. Participating web/MCP/Office mutations must invalidate/update
tracked desktop handles and coordinate conflicting operations; external writers remain a
backend concern. Persist post-commit event work for retry so failed notification never causes
the actual upload to run again.

## Native synchronization

Implement `createItem`, `modifyItem` and the selected Trash callbacks using a shared Swift
mutation coordinator, not a second filesystem watcher. File Provider owns detection of local
changes and scheduling/retry; the journal supplies durable identities, bases and receipts.

- Upload from the callback's file URL using file-backed URLSession tasks and bounded hashing.
  Do not load the file into `Data`. Report upload progress and propagate cancellation end to end.
  Call completion once, after remote commit and catalog persistence. Apple's callback URL is
  system-owned and may disappear after completion; any required retained copy must be made
  beforehand in owned staging. Clean only owned files.
- Respect `changedFields`: filename and contents supplied together are synchronized together.
  Safe-save editors may use temporary files, rename, replacement and removal; test the whole
  sequence before enabling general saves. Do not claim atomic changes in the extension plist
  unless observable behavior satisfies Apple's definition.
- Handle `mayAlreadyExist`, dataless reimport, `deletionConflicted`, unknown initial bases and
  `failOnConflict` explicitly. A nil URL is not permission to upload an empty replacement.
  Reimport must never overwrite an existing remote file merely because its name matches.
- Migrate catalog v2 in place: add pending/base/server-handle fields and move/tombstone events.
  On acknowledged folder moves, relocate descendant paths, parent references, tracked folders
  and outstanding dependencies atomically while retaining UUIDs/materialized flags.
- Invalidate outstanding listing reservations on mutation. Refresh must not remove a pending
  create, restore a deleted name, undo a rename or overwrite the base of a pending edit.
  Record remote observations separately; resolve them against local intent after the operation.
- Current `changes(since:parent:)` filters by the item's latest parent. Add change records that
  can report removal from the old parent and addition to the new one. Signal both parents and
  the working set; do not depend on eventual polling for local write visibility.
- Preserve lazy downloads and OS-owned cache management. Dirty files must not be discarded
  during validation, eviction, reconnect, migration or auth failures.

Conflict policy: keep the remote version and preserve the local bytes as a separately named
conflict copy using exclusive creation. If that upload cannot finish, retain local pending
content and show recovery. For `failOnConflict`, report the framework's conflict result rather
than automatically resolving it. Name collisions and stale deletes are distinct errors.
Expose Retry, Save a copy and explicit resolution; do not offer unconditional overwrite.

Replace the existing coarse error mapping: 403 is permission denial, not always expired login;
409 is not always an expired listing. Distinguish stale version, collision, quota/disk full,
authentication, unsupported operation, network failure and uncertain commit. Use documented
File Provider persistent errors for blocked work; signal resolution after reconnect or user
action to avoid either endless retries or permanently stranded uploads.

## Trash and disconnect

Finder Trash is a separate slice. Apple's `deleteItem` means permanent deletion; native
trashing reparents through the Trash container. Do not directly map the existing delete stub
to a recoverable operation and claim full native Trash support.

Add Trash-container enumeration, stable recovery handles, restore by reparenting and retained
original parent/name metadata. Reuse configured provider recovery underneath. SFTPGo's native
directory recycling splits files into leaves, while WebDAV can move a whole directory; prove
restoration of empty/nested folders and preserve item mappings before advertising Trash.
If existing provider recovery is insufficient, add a manifest/adapter capability for it.
Deletion conflicts and newly added remote descendants must not be discarded by a stale request.
Permanent purge stays unavailable. Test editor temporary-file cleanup and Finder refusal
behavior with that restriction; unresolved safe-save failures block the affected write release.

Before Disconnect, reconcile native pending activity with the journal and active callbacks.
The pending-set enumerator alone is incomplete: it can omit initial uploads and is bounded.
Offer Wait for sync or preserve/export pending content before domain removal; abandon it only
after an explicit user choice. Revocation/provider failure must leave recovery possible.
Prevent new callbacks racing domain removal. Retain existing domain IDs when reconnecting or
changing access; failed cleanup remains retryable and isolated to its location.

## Delivery sequence

| Milestone | Exit evidence | Estimated incremental effort |
| --- | --- | --- |
| Provider write proof | Conditional create/replace, interrupted upload and external writer races on both fixtures; concrete backend support decision | 2-4 days |
| Protocol and recovery foundation | v1 compatibility, approved write credential upgrade, v2 contracts, durable receipts, catalog migration and pending-refresh protection | 4-6 days |
| Upload and Save | New files/folders and existing-file edits through signed Finder; offline replay, conflict preservation and crash recovery | 5-8 days |
| Organization and recovery | Rename/move with stable descendants; native Trash/restore where proven; pending-aware disconnect | 5-8 days |
| Writable beta qualification | Editor/race/failure matrix, upgrade of installed app and locally signed/notarized build | 3-5 days |

Estimate: **4-7 developer weeks beyond the merged client**, conditional on the provider proof.
Missing upstream primitives or a new SFTPGo integration increase this estimate; resolve that
before scheduling the remaining work. Distribution tooling is reused. Hosted release and
second-Mac qualification remain separate existing gates. Keep Actions disabled per the current
handoff; implementation and local verification do not require enabling hosted workflows.

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
