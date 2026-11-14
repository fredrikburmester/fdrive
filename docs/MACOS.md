# FDrive for Mac

The native companion provides Finder locations on macOS 26+ (Apple silicon), with optional
writes (see [write configuration](#write-configuration-and-recovery)).
It is a development preview. [Remaining beta qualification](plans/MACOS-APP.md) includes
the first hosted release, Homebrew installation and tests on another Mac.

## Connect and use

1. Build and launch the signed app using the instructions below.
2. Enter the fdrive web address. HTTPS is required; HTTP loopback works for development.
   The address field shows until a location exists; **Add Server** brings it back to allow
   more logins.
3. Sign in in the browser, compare the connection code and select storage logins and access.
4. Open a location from the app. Click **Enable** in Finder if macOS requests it.

The app checks each location's Finder registration on every refresh. A location whose
extension was turned off shows the System Settings path (General › Login Items &
Extensions › File Providers) with an **Open System Settings** button; one whose domain is
missing or disconnected asks for Reconnect. Server refresh continues for disabled locations
so re-enabling shows current data.

An upgrade replaces the app bundle under the running app, which would otherwise keep running
the old code while Finder starts the new extension. Every 30 seconds the app reads the
installed version from disk. After it has seen the same newer (or older) build twice, it
launches the installed copy and quits, keeping the locations window open or closed as it was.
It waits while FDrive is the active app or a pairing, license change or disconnect is under
way. If the new copy cannot be launched, the app asks you to quit and reopen FDrive.

Each selected server/account/identity gets its own domain, token and metadata database.
The fdrive server reads and writes the files folder; the Mac talks only to the fdrive API. Switching the web app's active login cannot retarget a native location.

Browsing retrieves directory metadata without fetching original file contents to the Mac.
Opening, Quick Look, copying out and other applications' reads fetch contents on demand.
Opening a package can read multiple files. The extension supplies generic file types/icons.
No app search or remote search is implemented; macOS may index metadata it already knows.

Read-only locations display **Locked** in TextEdit. Writable locations support file saves,
new files/folders, rename, moves and recoverable Finder Trash within the location.
See [write configuration and recovery](#write-configuration-and-recovery) before enabling writes.

The app appears in the Dock and Command-Tab while its locations window is open, including
when minimized or behind another app. Closing the window returns it to the menu bar; choose
**Locations and Settings** from the FD menu to reopen it. A copy of FDrive that Finder does
not use (older than the installed app, run from a disk image, or missing its extension) says so
in the window footer and disables Add Server, Reconnect and Disconnect.

The app refreshes browsed folders and materialized files every 60 seconds, on wake,
after pairing and on manual Refresh. When the server advertises `changeFeed`, a refresh asks
[the change feed](#change-feed) what changed since the anchor the location stored, usually in
one request, and lists only the browsed folders it names, plus Trash and folders whose last
listing was not applied in full (after the app's own write there, a skipped pending write or
a denied listing). It validates only downloaded files at or below a changed path. The new
anchor is stored only once everything named before it was applied: a failed listing or
validation keeps the old one, so the next refresh asks again from it. A folder that is gone
counts as applied; one this connection may not read loses its token and is listed by every
refresh until it can be read, rather than holding the anchor back. With no anchor, when the
server answers `resync`, after more than 50 pages of changes, after a failed feed request, on
Refresh, pairing and license activation, and at least once an hour, the refresh checks every
folder as described next and then continues from the anchor the feed gave before that check.

The hourly check is the safety net for what the feed cannot see. The feed is fdrive's change
journal: changes made through fdrive are in it at once, but a change made on the server's
disk directly (over SMB, rsync or Syncthing) reaches it only once the indexer's watcher sees it,
within seconds, or its scan does, hourly by default and at its start after downtime. The
indexer journals nothing for names it skips (`.git`, `node_modules` and similar), nor for a file
rewritten with the same size and modification time, nor while the files folder lacks its
marker. An hour matches that default scan interval, so a change the watcher missed is no later
in Finder than in search; for a 1,700-folder location it costs about 17 check requests an hour,
where checks alone sent them every six minutes.

Without the feed, when the server advertises `listingChecks`, a refresh sends each browsed
folder's listing token in batches of 100 and lists only the folders the server reports changed,
plus Trash and folders without a token; otherwise it lists every browsed folder separately.
A refresh that read every browsed folder on the server, checked or listed, waits four times as
long as it took and at least a fifth of a second per browsed folder before the next automatic
one, up to 15 minutes: a 1,700-folder location checks about every six minutes, where listing it
took three minutes per pass. A refresh that followed the feed read only what changed, so it
waits only four times as long as it took, and such a location shows a change within about a
minute. Only Refresh, pairing and
license activation show progress; background refreshes keep each location's last status, and
Refresh replaces one already running. The extension records a heartbeat in the shared
catalog on every enumeration and download callback; if Finder has not answered a signalled
refresh within two intervals while the domain is enabled, the location shows a warning that
Finder, not the server, is unresponsive. Nothing is restarted automatically. Failures back off to 15 minutes independently per
location. Closing the window keeps it running; Quit stops proactive refresh. Launch at login
is optional. The system can invoke the extension independently to browse/download.
An unreadable folder retains its last complete snapshot while other folders refresh. Completed
changes reach Finder even when another listing or content validation fails; the failure still
appears in the location status. A validation batch containing a missing or unreadable file
retries files individually; server outages retain the normal batching and backoff.

Previously listed folders can show their cached listing offline. Downloaded files can reopen
while macOS retains their local copy. Unvisited folders and uncached files require the server.
Finder's **Remove Download** removes local content only. There is no permanent offline pinning.
Read-only locations use `downloadLazilyAndEvictOnRemoteUpdate`; writable locations use
`downloadLazily` to preserve pending edits. The OS owns cache eviction and retry scheduling.

Reconnect rotates that location's credential while retaining its domain/catalog IDs.
Disconnect refuses pending journaled writes, then removes the domain using File Provider's
`preserveDirtyUserData` mode before clearing metadata/Keychain state. Any additional dirty
files retained by macOS are revealed in Finder. Failed cleanup stays visible for retry. Telling the
server is a courtesy with a ten-second limit, never a precondition: when it cannot be reached, answers
with an error, or no longer serves fdrive, the location is still removed and the app says the
credential remains until it expires or is revoked from Account → API tokens, which works at any
time. Revocation cannot erase previously exported copies.

### Display-name refresh

The app shows the provider name with the username and fdrive host beneath. Refresh reads current display
metadata from the existing fdrive server and first verifies account, identity and provider IDs.
It applies only the name and username, preserving the saved server, grants, expiry, domain ID,
Keychain token and SQLite catalog. A failed or offline refresh retains the last saved name.
The root item's metadata version changes when its title changes; cached child items survive.

The registered Finder domain uses `NSFileProviderManager.add` with its existing identifier,
which supports changing the display name in place. The domain is never removed for a rename.
The signed macOS 26 rehearsal preserved downloaded bytes and file inode while the CloudStorage
folder changed from `FDrive-Initialstorage(alice)` to `FDrive-Homestorage(alice)`.

Finder controls the visible sidebar name: with one domain it may display the app name
**FDrive** even after the registered domain and folder rename. This was observed in the signed
rehearsal and is also reported in [Apple's developer forum](https://developer.apple.com/forums/thread/737617).
No unsupported Finder preference changes or extra placeholder domains are used to override it.

## Trial and license

Released builds are free for 7 days, then need a one-time license key. The trial starts the
first time the app or its extension runs on a Mac. **Enter License…** activates a key for this
Mac; **Deactivate This Mac…** frees its seat for another one. Builds compiled without a seller
(`FDRIVE_LICENSE_ORGANIZATION` unset, the default from source) are not gated at all.

The record (trial start, key, activation ID, last validation) is one item in the shared Data
Protection Keychain, so reinstalling or `brew uninstall` does not restart the trial. The app
revalidates a license weekly against [Polar's public license endpoints](https://polar.sh/docs/api-reference/customer-portal/license-keys/validate),
which take no credential; nothing but the key, the organization ID and the Mac's name is sent.
Only a definitive answer (revoked, disabled, expired or unknown key) removes a license. An
unreachable seller never does until 30 days have passed without a successful check, and an
unreadable Keychain leaves the app usable.

The File Provider extension enforces the same state, because Finder runs it without the app.
When the trial has ended or validation is overdue, every callback returns File Provider's
resolvable `notAuthenticated` error: macOS keeps downloaded files, local edits and pending
uploads, and retries them after the app signals that the error is resolved on activation.
Domains, catalogs, credentials and recovery files are never removed by licensing, and the app
stops its server refresh while paused.

## Write configuration and recovery

Writes need an explicit **Read and write** pairing grant and persistent server recovery storage
(`FDRIVE_DESKTOP_STATE_DIR`). The deployment Compose file mounts the `fdrive-desktop` volume at
`/var/lib/fdrive/desktop`. Multiple API processes must share this filesystem and the same
PostgreSQL database. Nothing is set per storage: the files folder accepts Mac writes under
the contract below.

**Write contract.** fdrive serializes Mac writes against each other through a
per-identity PostgreSQL lock and, holding it, snapshots the destination, digests that snapshot
against the version the Mac edited, and only then replaces the file. A change made at any
earlier point is refused as a conflict with the pending copy preserved, and the replaced version
is kept as a backup under `/.fdrive-desktop`. Nothing fences a concurrent writer at the
storage: anything on the host (rsync, SMB, Syncthing, the OCR service) can write the files
folder. Moves, folders included, are one rename.

That lock covers Mac writes only. The web app, Collabora and the OCR service write the volume
directly and do not take it: for each of them publication *is* the transfer, and holding an
identity for the length of an upload is the cost this contract exists to avoid. The content proof
catches them the same way it catches a writer outside fdrive entirely — and, the same way, a
write of theirs landing between that proof and the replacement is silently lost, with the retained
backup holding the pre-fdrive content rather than the lost version. OCR's own size and mtime
checks mean a collision there is refused on both sides rather than silently applied.

**Upload size.** fdrive accepts files up to 16 GiB.

Publication is refused, and every location stays read-only, only when the server has no recovery
storage or no publish lock; the Mac app shows that reason on each card. A publication the
storage refuses outright leaves the operation discardable from the Mac app; only one whose
outcome is genuinely unknown waits for an administrator. Credentials issued as
read-only stay read-only; Reconnect grants access without changing the domain.

Protocol 2 uses `/api/v2/desktop`; protocol 1 is unchanged. New apps fall back to read-only
protocol 1 when an older server returns 404. Uploads have separate prepare, file-body upload,
commit, status, acknowledgement and cancel requests. Folder and move requests use the same
operation ledger. UUID handles and operation IDs never replace current account/path checks.

The server hashes and fsyncs the incoming body before commit. It checks the source base and
destination, stages and validates new bytes, backs up an existing file, then publishes with an
atomic rename, fenced by the per-identity lock plus the pre-publication recheck. Original backups remain under the reserved
`/.fdrive-desktop` namespace, hidden from native ordinary reads and from the web file tree.
Failed staging reuses its recorded directory. A commit whose publication cannot be confirmed stays
uncertain and cannot automatically replay as a new write. The completed receipt and a metadata
recovery job commit in one PostgreSQL transaction after publication. A failure before that
transaction commits remains uncertain; an effect failure after it commits leaves the receipt
completed. Replaying or acknowledging that receipt never republishes the file.

The API drains the durable queue at startup, after saves and every five seconds. Each job
updates tags, favorites, recents, folder views, mapped Office registrations and the paths of
public links atomically, then commits before dispatching its filesystem notification. Links
carry no revisions: what they do is decided before publication from where the item really
moves, into and out of the Mac's Trash too. Delivery is a second durable
pending phase: retries send only the notification and never reapply metadata. Before another
native publication, older pending work for the identity must finish; other identities continue. Recovery bounds lock waits to two seconds and individual
statements to fifteen seconds. Failed jobs use exponential backoff, capped at five minutes.
Shutdown waits for active recovery before closing the database. No Mac connection or storage
credential is needed, and the worker never changes file contents or backups.

Jobs capture trusted Office locations and metadata row revisions before filesystem publication
(at most 100,000 source/destination revisions). Capacity exhaustion returns `quota_exceeded`
with the operation still ready and the source untouched. Receipt persistence uses that bounded
snapshot without recapturing later metadata growth. Identity, Office-root and row locks
protect concurrent edits. Upgrade all API writers together; older binaries neither rotate
these revisions nor invalidate superseded recovery destinations.
Recovery only changes matching captured revisions: later source edits survive, and newer
destination metadata blocks the transaction for inspection. Later web/MCP/Office/indexer
move or delete hooks invalidate overlapping queued destinations, including descendants and
paths with no current metadata. Exact move replays remain idempotent. Superseded jobs preserve
their snapshots and stay pending for attention rather than attaching metadata to a reused path.
Account ownership changes retire old jobs. Successful metadata application discards snapshots
while retaining notification delivery state. Restoring into an overlapping original path
hierarchy is refused before publication to avoid overlapping metadata moves.

Administrators can inspect the first 100 pending jobs at `GET /api/v1/desktop/recovery`;
`attempts`, `lastError` and `nextAttemptAt` show retry/failure state without file contents or
credentials. The same response lists up to 100 `uncertain` commits (state, kind, name and
whether a `committing` row has stalled for 15 minutes). After inspecting storage, an
administrator resolves one with `POST /api/v1/desktop/recovery/:identityId/:operationId/resolve`
and `{"outcome":"published"}` or `{"outcome":"discarded"}`. `published` verifies the target
exists (and, for saves, carries the uploaded digest), records the receipt and queues the
usual metadata recovery; `discarded` cancels the operation and leaves spool and backups to
retention. Neither replays bytes. Failures also appear in the General System log. Do not
delete queue or receipt rows to clear a conflict: inspect the preserved source/destination
metadata first. A recovery administration UI remains separate work. Filesystem notifications use
the existing identity-scoped in-process event bus; a crash can repeat a notification. Disconnected
clients refresh on reconnect, and indexing remains the indexer's responsibility.

A file is limited to 16 GiB. Admission allows 1024 active operations and 64 GiB of combined
pending payload/recovery reservations across the installation. Acknowledgement releases the
incoming-body reservation, while retained originals stay charged. Cancelled operations keep
their reservation because remote staging may remain. A retention job runs every ten minutes:
bodies idle for 24 hours and conflicts untouched for 7 days are cancelled and their spool
removed; acknowledged and cancelled operations older than `FDRIVE_DESKTOP_RETENTION_DAYS`
(default 30) have their remote recovery tree removed under a write lease, then their
reservation released. Only directories containing the expected `incoming`, `previous` and
`renamed-original` files are removed; anything unexpected defers that operation with a
General System log warning. Committing and uncertain operations are never reclaimed.
Capacity exhaustion still refuses new writes; do not remove ledger rows to bypass it.

The native catalog stores immutable pending copies before networking, and records the remote
receipt before acknowledging Finder. Retry uses the same operation. Offline edits synchronize
when the connection recovers. A conflicting file save creates a uniquely named conflict copy,
preserving the remote original; if that name is taken too, numbered names are tried up to
three times before the error stands. `failOnConflict` retains the local edit with a visible error.
**Show recovery files** opens pending contents and a readable operation/error list. Never erase
that directory to clear a synchronization error. Uncertain commits require manual recovery.

Finder **Move to Trash** reparents through the native Trash container. In the app's location
menu, **Restore from Trash…** lists retained files and folders. **Restore** returns an item to
the top level of that location; move it into another folder afterwards if needed. Recovery
names include a short ID while keeping
the file extension; restore removes that suffix and refuses an occupied destination. Files,
nested folders and empty folders retain their server handles. Trash survives disconnect and
reconnect because the server retains its original-path mapping. Finder **Put Back** is not
available. Permanent-delete callbacks reject the request and ask macOS to restore the local
item; no desktop purge endpoint exists, even if Finder displays Delete Immediately or Empty.

Moving a folder into its own descendant is refused natively before any pending record exists
and again by the server at commit. A system reimport (`mayAlreadyExist`) acknowledges an
existing remote item of the same name and kind when the local bytes match its verified
content; differing bytes create normally so the server's collision handling keeps both, and
absent bytes never replace remote content.
Catalog v3 preserves existing local IDs, tracks server handles, pending writes and both sides
of parent changes. Acknowledged folder moves retain cached descendants. Refresh skips pending
items. Own saves retain the editor's timestamp independently of canonical remote versions.
Native permanent deletion, general safe-save temporary-file cleanup, symlinks, atomic package
writes, resource forks and cross-domain move guarantees are not supported. The complete
[write acceptance plan](plans/MACOS-WRITES.md) remains open.

## Build and verify

Use Xcode 26+ with its command-line tools selected. The checked-in Xcode project needs no
generator dependencies for normal builds. From the repository root:

```sh
# Shared Swift tests:
swift test --package-path apps/macos --scratch-path .fdrive-workflow/swift-build

# Unsigned app/extension build:
xcodebuild -project apps/macos/fdrive.xcodeproj -scheme fdrive -configuration Debug \
  -derivedDataPath .fdrive-workflow/macos-build-unsigned -destination 'platform=macOS,arch=arm64' \
  build CODE_SIGNING_ALLOWED=NO

# Development-signed build using your Xcode signing account/team:
xcodebuild -project apps/macos/fdrive.xcodeproj -scheme fdrive -configuration Debug \
  -derivedDataPath .fdrive-workflow/macos-build-YOUR_TEAM_ID -destination 'platform=macOS,arch=arm64' \
  build DEVELOPMENT_TEAM=YOUR_TEAM_ID -allowProvisioningUpdates
```

The signed app is under
`.fdrive-workflow/macos-build-YOUR_TEAM_ID/Build/Products/Debug/FDrive.app`.
Open it through Xcode or Finder. Automatic signing may access your configured developer
account. Unsigned builds cannot establish real File Provider signing/permission behavior.

The generator is `tools/macos/generate-project.rb` (Ruby gem `xcodeproj` 1.27.0).
Regenerate it only when changing project structure/settings.
The app and menu-bar icons reuse `apps/web/src/app/icon.svg`. The generated asset catalog
is checked in, so Xcode builds need no image tooling. After updating the web icon, regenerate
the macOS sizes with `node tools/macos/generate-icons.mjs`
in a checkout prepared with `pnpm install`.
Both targets use the same team and:

| Setting | Value |
| --- | --- |
| App identifier | `se.burmester.fdrive.mac` |
| Extension identifier | `se.burmester.fdrive.mac.fileprovider` |
| App Group | `$(TeamIdentifierPrefix)se.burmester.fdrive.mac` |
| Shared Keychain access group | `$(AppIdentifierPrefix)se.burmester.fdrive.mac.shared` |
| Security | App Sandbox, outgoing network, hardened runtime |

The macOS team-prefixed App Group is deliberate. A `group.*` identifier without matching
provisioning authorization can let the creator app access its container while denying the
extension, causing Finder's generic loading error. See
[Apple's App Group guidance](https://developer.apple.com/documentation/xcode/accessing-app-group-containers).
Credentials use the shared Data Protection Keychain with AfterFirstUnlockThisDeviceOnly.

The **macOS native** GitHub workflow is manual. It builds unsigned and runs Swift tests. Backend work still requires the application and
integration checks, and browser pairing requires `pnpm test:e2e e2e/desktop.spec.ts` and live
UI inspection. Native checks supplement these gates.

For distribution, archive the Release scheme with Developer ID signing in Xcode, export via
Developer ID distribution, notarize and staple. Keep the same identifiers and groups for
upgrades. An Apple Development or Apple Distribution certificate is not a substitute for a
Developer ID Application certificate. No notarized download is produced by the development
verification helper. [Apple distribution guidance](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

Automated signed DMGs, Apple/GitHub credential setup, release tags and Homebrew installation
are covered in the [release guide](MACOS-RELEASE.md).

## API and security

Desktop protocol v1 lives at `/api/v1/desktop`; contracts are in
`packages/contracts/src/desktop.ts`. Browser session authorization remains separate.

| Endpoint | Authorization and behavior |
| --- | --- |
| `POST /pairings` | Creates a five-minute request, app-held secret and visible code |
| `GET /pairings/:id` | Signed-in browser reads device/code/expiry only |
| `POST /pairings/:id/approve` | Browser session, CSRF and ownership of selected identities |
| `POST /pairings/:id/poll` | App secret; repeated redemption returns the same issued bundle |
| `POST /pairings/:id/cancel` | App secret; cancels issuance and revokes unconfirmed credentials |
| `POST /pairings/:id/confirm` | App secret; the bundle is stored on the Mac and survives expiry |
| `GET /location` | Desktop bearer; current identity/provider and readonly protocol |
| `GET /entries?path=&cursor=` | Authorized, bounded metadata snapshot; protocol 2 adds a `token` to a complete single-page listing outside Trash |
| `POST /checks` | Protocol 2: up to 200 `{path, token}` pairs; answers `unchanged`, `changed`, `missing` or `forbidden` per folder, and only a leading part when its 30-second budget runs out |
| `GET /changes?since=` | Protocol 2, where `location` says `changeFeed`: the paths changed since an anchor and the folders whose listings they changed, in the location's own paths, with the next anchor and `more`; `resync` and a fresh anchor otherwise. See [change feed](#change-feed) |
| `GET /entry?path=` | Current entry, with ancestor/symlink checks |
| `GET /content?path=` | Original streamed bytes; no MCP size cap |
| `POST /versions` | Content versions (sha256) of up to 16 authorized files for cache validation, from the index where it provably holds them |
| `POST /disconnect` | Revoke this bearer only |

Desktop tokens use `fdd_`, distinct from MCP's `fdr_`; neither audience accepts the other.
Tokens have identity-root read or explicitly approved full grants and expire after 365 days. Only hashes are persisted
server-side. Native read requests resolve token expiry/revocation, account ownership and
the current provider binding. Neither a cursor nor a local item ID grants access. The native
client refuses redirects, cookies and non-loopback HTTP, and never puts bearer secrets in URLs.
Existing upstream OTP/reauthentication requirements still apply.
Disconnect validates possession of the desktop secret and revokes only that token's hash;
it works after provider disablement or token expiry without resolving storage credentials.

Pairing state is in memory: server restart cancels pending pairing. Limits are eight requests
per IPv4 address or IPv6 /64 and 512 per process. One shared issuance promise handles
concurrent poll retries; partial issuance rolls back. The app persists the pairing record
(server, request ID, secret, expiry) in its App Group container before the first poll and
confirms after every credential is in the Keychain; a crash in between is resumed at the
next launch with the same bundle. A bundle nobody confirms is revoked when the five-minute
window closes, so an orphaned credential never outlives the pairing. Snapshot cursors bind identity, bearer
and path, expire after 120 seconds and hold at most 100,000 entries; at most 32 unfinished snapshots exist per API
process. Pages contain 500 entries. Provider-specific limits can be lower. Overflow/errors
fail visibly instead of truncating a folder. Multi-process deployments need sticky routing
for pairing and listing snapshots or a shared transient store.

### Change feed

`GET /api/v2/desktop/changes` reads fdrive's change journal (`idx.changes`, see the
[change journal plan](plans/CHANGE-JOURNAL.md)) for one location. A location has a feed, and
its v2 `location` says `changeFeed: true`, when its login's index root is indexed
(`FDRIVE_INDEX_ROOTS`), this API journals its own changes under that root (the root's
`storagePath` is the files folder) and the indexer has created the root. Otherwise the route
answers 404 and the app uses folder checks. Older apps ignore the key and keep using checks.

Rows are read under the location's verified index scopes ([scoping](SCOPING.md)): each end of a
row, its path and a move's target, is mapped from the root-relative path with the round trip
index reads use, so folders shared with the login appear under `/Shared with me`, a path no scope
covers or one a shared folder shadows is dropped, and so is anything the location's listings
hide (fdrive's own folders such as Trash and `/.fdrive-desktop`, outside its grants). A row
does not say whether it was a file or a folder, so each kept end is a changed **path**, below
which the app lists every browsed folder and validates every download. Its parent and grandparent are changed **folders**: the parent's
listing holds the path, and the grandparent's shows the parent's modification time, which is
part of the version a Finder rename of that folder must match. Paths and folders inside another
changed path are left out, and each appears once.

The anchor is opaque to the app: `v1.<epoch>.<fingerprint>.<position>`. The epoch is a random id
in `idx.change_epoch`, which backups never include, so a restore, after which positions start
again at 1, gets a new one. The fingerprint covers the location's scopes and their roots' ids,
so sharing or unsharing a folder, or a root created again, changes it. A mismatch of either, an
unreadable anchor, one past the journal's end and a gap (rows after it were pruned, past 30
days) answer `resync` with an anchor at the journal's end, as does a request without one, so a
new app starts from now after one full check. An answer covers up to 1,000 rows; with `more`,
the app asks again from its anchor before applying anything. A complete answer's anchor is the
journal's end, read before the rows, so a location whose root is quiet keeps up with the
journal instead of falling into a gap.

## Metadata, versions and limits

One SQLite catalog per domain stores UUID items, paths, browsed folders, materialized flags,
tombstones, a generation and revision anchors. WAL and transactions serialize app/extension
writes. Listing reservations prevent an older concurrent network response overwriting a
newer snapshot. Only complete valid listings reconcile; failures never imply deletion.

Schema v5 migrates v1–v4 in place; v5 adds the change feed's anchor and when every folder was
last checked. A folder's token is kept only when its listing was applied
in full; any listing without one, a skipped pending write and the app's own writes to the
folder clear it, so `unchanged` always means the catalog matches the server. The catalog also
records a listing applied in full without a token (one of several pages), so the feed does not
list that folder again until something in it changes. Metadata edits preserve IDs; an observed removal tombstones
the item and known descendants, and a later recreation receives a new ID. External moves
appear as removal plus addition. Path-only backends cannot prove a delete/recreate or rename
that occurred entirely between observations. With protocol 2 server handles, a changed
handle or kind at an unchanged path is treated as delete plus recreate, so cached bytes are
never served for the new item; a handle observed at another path keeps its item and
downloaded content. Names colliding by Unicode normalization/case, containing a colon, or
named `.Trash` in the root of a writable location fail the listing with guidance rather
than merge, hide or shadow distinct entries. Symlinks and other special entries have no
reading capability.

The most recent 100,000 revisions retain deletion evidence. Older tombstones are pruned;
anchors before the retained floor or from another generation force resynchronization.
Live metadata remains proportional to the number of items in browsed folders.

First download computes SHA-256 locally in 1 MiB chunks and validates transfer length. Later
refresh validates only materialized files on the server, one batch at a time per identity. This
detects different bytes even when size/mtime are unchanged. A file whose index row the indexer
stamped from its own read ([stamps](INDEXER.md#stamps)) is answered with the row's sha256
while a fresh stat still shows the row's inode, change time, size and modification time; any
other file is read and hashed in full. No originals are sent to the Mac by validation.

Downloads use URLSession temporary files, then the manager-provided transfer directory.
A free-space preflight (file size plus 512 MiB headroom) refuses downloads and saves that
would fill the volume with a distinct out-of-space error; local write failures are never
reported as server outages. Cancellation/validation failures remove files owned by the
failed operation. On success, ownership passes to macOS. Transfer progress is native; resume/sparse fetching is deferred,
so opening a large file may require its complete initial download. Crash/low-disk cleanup
and multi-gigabyte transfer behavior still need the release rehearsal listed in the plan.

Never modify File Provider's databases or `~/Library/CloudStorage` internals. Diagnose through
the app status, `fileproviderctl dump se.burmester.fdrive.mac.fileprovider -l`, and unified
logs for `FdriveFileProvider`. The "Finder has not responded" warning means the app signalled changes newer than the
extension's last callback and, two minutes later, the extension still has not run one: check the
`fileproviderctl` output and logs for the daemon rather than the server. A location with nothing
new is never flagged, because the daemon may skip enumeration for it. Native registration/opening issues are distinct from API
connectivity. `getUserVisibleURL` is security-scoped and must remain scoped through Finder
launch. Local metadata-only callbacks return canonical attributes; rejected remote
writes use File Provider's persistent `cannotSynchronize` error, avoiding transient retry loops.
A 401 means the credential expired or was revoked (reconnect); a 403 on reads is a denied
path or unsupported entry and is not reported as an expired login. Unclassified 409s on
writes surface as conflicts rather than stale listings.
