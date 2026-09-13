# FDrive for Mac

The native companion provides read-only Finder locations on macOS 26+ (Apple silicon).
It is a development preview. [Remaining beta qualification](plans/MACOS-APP.md) includes
the first hosted release, Homebrew installation and tests on another Mac.

## Connect and use

1. Build and launch the signed app using the instructions below.
2. Enter the fdrive web address. HTTPS is required; HTTP loopback works for development.
3. Sign in in the browser, compare the connection code and select storage logins.
4. Open a location from the app. Click **Enable** in Finder if macOS requests it.

Each selected server/account/identity gets its own domain, token and metadata database.
SFTPGo and WebDAV adapters run on the fdrive server; the Mac does not implement either
protocol. Switching the web app's active login cannot retarget a native location.

Browsing retrieves directory metadata without fetching original file contents to the Mac.
Opening, Quick Look, copying out and other applications' reads fetch contents on demand.
Opening a package can read multiple files. The extension supplies generic file types/icons.
No app search or remote search is implemented; macOS may index metadata it already knows.

Files are read-only: TextEdit displays **Locked**. Use Duplicate or copy a file outside the
location to edit it. Finder excludes remote rename, move, Trash and folder creation. Native
write callbacks and the desktop API also reject remote mutations. A program that deliberately
changes local filesystem permissions may create a local change that cannot synchronize;
the server still accepts no writes through desktop credentials.

The menu-bar app refreshes browsed folders and materialized files every 60 seconds, on wake,
after pairing and on manual Refresh. Failures back off to 15 minutes independently per
location. Closing the window keeps it running; Quit stops proactive refresh. Launch at login
is optional. The system can invoke the extension independently to browse/download.
An unreadable folder retains its last complete snapshot while other folders refresh. Completed
changes reach Finder even when another listing or content validation fails; the failure still
appears in the location status. A validation batch containing a missing or unreadable file
retries files individually; server outages retain the normal batching and backoff.

Previously listed folders can show their cached listing offline. Downloaded files can reopen
while macOS retains their local copy. Unvisited folders and uncached files require the server.
Finder's **Remove Download** removes local content only. There is no permanent offline pinning.
Remote updates use `downloadLazilyAndEvictOnRemoteUpdate`; the OS owns cache eviction.

Reconnect rotates that location's credential while retaining its domain/catalog IDs.
Disconnect cancels refresh, revokes the token, removes the domain through File Provider and
then clears metadata/Keychain state. Failed cleanup stays visible for retry. Account → API
tokens can revoke access independently. Revocation cannot erase previously exported copies.

## Build and verify

Use Xcode 26+ with its command-line tools selected. The checked-in Xcode project needs no
generator dependencies for normal builds. From a prepared checkout:

```sh
# Shared Swift tests plus unsigned app/extension build:
bash tools/orchestration/verify-macos.sh "$PWD"

# Development-signed build using your Xcode signing account/team:
bash tools/orchestration/verify-macos.sh "$PWD" YOUR_TEAM_ID
```

The signed app is under
`.fdrive-workflow/macos-build-YOUR_TEAM_ID/Build/Products/Debug/FDrive.app`.
Open it through Xcode or Finder. Automatic signing may access your configured developer
account. Unsigned builds cannot establish real File Provider signing/permission behavior.

The generator is `tools/macos/generate-project.rb` (Ruby gem `xcodeproj` 1.27.0).
Regenerate through `run-in-checkout.sh --lock` only when changing project structure/settings.
The app and menu-bar icons reuse `apps/web/src/app/icon.svg`. The generated asset catalog
is checked in, so Xcode builds need no image tooling. After updating the web icon, regenerate
the macOS sizes with `bash tools/orchestration/run-in-checkout.sh "$PWD" --lock -- node tools/macos/generate-icons.mjs`
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

The **macOS native** GitHub workflow is manual to preserve the repository's Actions budget.
It builds unsigned and runs Swift tests. Backend work still requires `application` and
`integration`, browser pairing requires `browser desktop.spec.ts` and live UI inspection,
and docs/tools require `workflow`. Native checks supplement these gates.

For distribution, archive the Release scheme with Developer ID signing in Xcode, export via
Developer ID distribution, notarize and staple. Keep the same identifiers and groups for
upgrades. An Apple Development or Apple Distribution certificate is not a substitute for a
Developer ID Application certificate. No notarized download is produced by the development
verification helper. [Apple distribution guidance](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

Automated signed DMGs, Apple/GitHub credential setup, release tags and private/public Homebrew
installation are covered in the [release guide](MACOS-RELEASE.md).

## API and security

Desktop protocol v1 lives at `/api/v1/desktop`; contracts are in
`packages/contracts/src/desktop.ts`. Browser session authorization remains separate.

| Endpoint | Authorization and behavior |
| --- | --- |
| `POST /pairings` | Creates a five-minute request, app-held secret and visible code |
| `GET /pairings/:id` | Signed-in browser reads device/code/expiry only |
| `POST /pairings/:id/approve` | Browser session, CSRF and ownership of selected identities |
| `POST /pairings/:id/poll` | App secret; repeated redemption returns the same issued bundle |
| `POST /pairings/:id/cancel` | App secret; cancels issuance and revokes any credentials issued |
| `GET /location` | Desktop bearer; current identity/provider and readonly protocol |
| `GET /entries?path=&cursor=` | Authorized, bounded metadata snapshot |
| `GET /entry?path=` | Current entry, with ancestor/symlink checks |
| `GET /content?path=` | Original streamed bytes; no MCP size cap |
| `POST /versions` | Hash up to 16 authorized files for cache validation |
| `POST /disconnect` | Revoke this bearer only |

Desktop tokens use `fdd_`, distinct from MCP's `fdr_`; neither audience accepts the other.
Tokens have identity-root read grants and expire after 365 days. Only hashes are persisted
server-side. Native read requests resolve token expiry/revocation, account ownership and
the current provider binding. Neither a cursor nor a local item ID grants access. The native
client refuses redirects, cookies and non-loopback HTTP, and never puts bearer secrets in URLs.
Existing upstream OTP/reauthentication requirements still apply.
Disconnect validates possession of the desktop secret and revokes only that token's hash;
it works after provider disablement or token expiry without resolving storage credentials.

Pairing state is in memory: server restart cancels pending pairing. Limits are eight requests
per IPv4 address or IPv6 /64 and 512 per process. One shared issuance promise handles
concurrent poll retries; partial issuance rolls back. Snapshot cursors bind identity, bearer
and path, expire after 120 seconds and hold at most 100,000 entries; at most 32 unfinished snapshots exist per API
process. Pages contain 500 entries. Provider-specific limits can be lower. Overflow/errors
fail visibly instead of truncating a folder. Multi-process deployments need sticky routing
for pairing and listing snapshots or a shared transient store.

## Metadata, versions and limits

One SQLite catalog per domain stores UUID items, paths, browsed folders, materialized flags,
tombstones, a generation and revision anchors. WAL and transactions serialize app/extension
writes. Listing reservations prevent an older concurrent network response overwriting a
newer snapshot. Only complete valid listings reconcile; failures never imply deletion.

Schema v2 migrates v1 in place. Metadata edits preserve IDs; an observed removal tombstones
the item and known descendants, and a later recreation receives a new ID. External moves
appear as removal plus addition. Path-only backends cannot prove a delete/recreate or rename
that occurred entirely between observations. Names colliding by Unicode normalization/case,
or containing a colon, fail the listing with guidance rather than merge distinct files.
Symlinks and other special entries have no reading capability.

The most recent 100,000 revisions retain deletion evidence. Older tombstones are pruned;
anchors before the retained floor or from another generation force resynchronization.
Live metadata remains proportional to the number of items in browsed folders.

First download computes SHA-256 locally in 1 MiB chunks and validates transfer length. Later
refresh hashes only materialized files on the server, one batch at a time per identity. This
detects different bytes even when size/mtime are unchanged. It **rereads those files from the
storage provider each refresh**, which can be expensive for large media or metered storage.
No originals are sent to the Mac by validation, but upstream bandwidth remains a beta tuning
gate. SFTPGo/WebDAV currently supply no common strong validator through the storage port.

Downloads use URLSession temporary files, then the manager-provided transfer directory.
Cancellation/validation failures remove files owned by the failed operation. On success,
ownership passes to macOS. Transfer progress is native; resume/sparse fetching is deferred,
so opening a large file may require its complete initial download. Crash/low-disk cleanup
and multi-gigabyte transfer behavior still need the release rehearsal listed in the plan.

Never modify File Provider's databases or `~/Library/CloudStorage` internals. Diagnose through
the app status, `fileproviderctl dump se.burmester.fdrive.mac.fileprovider -l`, and unified
logs for `FdriveFileProvider`. Native registration/opening issues are distinct from API
connectivity. `getUserVisibleURL` is security-scoped and must remain scoped through Finder
launch. Local metadata-only callbacks return canonical readonly attributes; rejected remote
writes use File Provider's persistent `cannotSynchronize` error, avoiding transient retry loops.
