# macOS native gaps: remaining fixes

Status: implementation plan, 2026-09-14. Five gaps survived the 100-case edge review
recorded in [STATUS](../workflow/STATUS.md); everything else is covered, documented in
[MACOS.md](../MACOS.md), or a rehearsal item in [beta qualification](MACOS-APP.md) and
[write work](MACOS-WRITES.md). Ordered by user impact. Each stage lands with its tests
first and can ship independently; none changes protocol 1 or existing catalogs.

## 1. Orphaned credentials after a crash mid-pairing (case 3)

Today `poll` issues a one-year token before the app persists it. A crash between the poll
response and `setToken` leaves a valid server credential with no Mac domain.

- **Server.** Add `POST /api/v{1,2}/desktop/pairings/:id/confirm` (app secret). Pairing
  gains `confirmed: boolean`. `prune()` revokes issued-but-unconfirmed tokens when a pairing
  expires or is cancelled, reusing `cancel`'s revocation path. Confirmation after expiry is a
  404 like every other late pairing call; the app then treats the bundle as lost and
  re-pairs. Poll after confirm still returns the same bundle for the window.
- **App.** Persist `{server, pairingId, secret, expiresAt}` in the connection store before
  the first poll. Install every credential (Keychain, locations, domain), then call confirm,
  then delete the record. On launch, an unexpired record is re-polled and installed (the
  server returns the cached bundle); an expired record is deleted. `cancelPairing` and a
  failed install still cancel server-side as now.
- **Tests.** `desktop.test.ts`: unconfirmed bundle is revoked at expiry and after cancel;
  confirmed bundle survives; confirm requires the secret; repeated poll after confirm is
  stable. `FdriveKit`: `ConnectionStore` pending-pairing round trip and expiry cleanup.
- **Docs.** MACOS.md endpoint table and pairing paragraph; contracts in `desktop.ts`.

## 2. Extension disabled in System Settings (case 17)

The app never reads the registered domain list, so status stays "Connected".

- Extend `refreshLocations`: before the metadata refresh, look up the location's domain in
  `NSFileProviderManager.domains()`. Missing domain: status "Location is not registered —
  Reconnect" and skip network work. `isDisconnected` or `!userEnabled`: status "Enable FDrive
  in System Settings → General → Login Items & Extensions → File Providers" with an **Open
  System Settings** button (`x-apple.systempreferences:com.apple.LoginItems-Settings.extension`),
  still refresh the catalog so re-enabling shows current data.
- Keep the decision pure: `func domainState(_ domain: NSFileProviderDomain?) -> LocationHealth`
  in `Native/` with the string mapping in FdriveKit (`LocationHealth` enum), unit-tested for
  each combination; the framework call itself is rehearsed on the signed build.
- **Docs.** MACOS.md "Connect and use" gains the re-enable path.

## 3. Health reflects enumeration, not only refresh (case 20)

Refresh talks to the server, so a wedged File Provider daemon still reads as healthy.

- **Extension heartbeat.** Every `enumerateItems`, `enumerateChanges` and `fetchContents`
  completion writes `state('lastCallbackAt')` and `state('lastCallbackError')` in the shared
  catalog (one `UPDATE`, no revision bump so anchors are unaffected).
- **App check.** After signalling enumerators on a successful refresh, record
  `signalledAt`. On the next refresh, if `lastCallbackAt < signalledAt` for more than two
  refresh intervals while the domain is enabled, status becomes "Finder has not responded
  for this location — see Troubleshooting" and the location row shows a warning; it clears on
  the next callback. Never restart or re-register the domain automatically.
- **Tests.** `Catalog` heartbeat read/write and the pure staleness rule
  (`enumerationStale(lastCallback:, signalled:, now:)`) with clock injection.
- **Docs.** MACOS.md diagnostics paragraph: what the warning means and the
  `fileproviderctl` steps.

## 4. Staging and backup retention (case 65)

Spool and recovery data only grow; capacity exhaustion refuses new writes.

- **Lifetimes** (server config with these defaults): `receiving`/`uploading` idle for 24 h →
  `cancelled`, spool removed; `conflict` idle 7 days → `cancelled`; `acknowledged` retained
  originals (`previous`, `renamed-original`, `incoming` staging) removed after 30 days and
  their `recoveryBytes` reservation released; `committing`/`uncertain` never reclaimed.
- **Reaper.** A durable job beside `createDesktopEffectsWorker`: `repo.expired(now)` selects
  candidates under the per-identity advisory lock, transitions state with the existing
  compare-and-set `transition`, then removes storage entries under `/.fdrive-desktop/<identity>/<op>`
  through the identity's storage factory with a write lease, and finally the local spool.
  Storage failure leaves the row for the next pass; nothing outside the internal namespace
  is ever touched, and a removal is refused if the directory contains an unexpected entry.
- **Administration.** `GET /api/v1/desktop/recovery` gains `uncertain` operations with
  request, receipt and paths; `POST /api/v1/desktop/recovery/:id/resolve` (admin) marks an
  uncertain operation `completed` or `cancelled` after the administrator has inspected
  storage. No automatic replay.
- **Tests.** `writes.test.ts` and `desktop.test.ts` for each lifetime and for refusing
  unexpected entries; `packages/db` integration for `expired` and reservation release;
  WebDAV and SFTPGo integration for backup removal under lease.
- **Docs.** MACOS.md limits paragraph; `integrations/sftpgo/README.md` capacity note.

## 5. Conflict-copy name already taken (case 81)

`conflictCopy` runs once per pending write; a second `name_collision` strands the save.

- In `resume`, when a superseded operation fails with `name_collision` (not
  `version_conflict`), call `catalog.conflictCopy(pending, attempt: n)` which appends a
  numbered marker `(conflict abcd1234-2)` and a fresh operation ID, up to three attempts,
  then surfaces the error. Replays keep returning the current attempt.
- **Tests.** `WriteTests` with the mocked transport: two collisions then success creates one
  file; the fourth collision reports the persistent error and keeps the pending copy.

## Deferred

Server-side distinction of 507 and 413 (case 68) needs a new `StorageErrorKind`; keep the
single remote quota error until a provider actually reports both. Automatic domain repair,
forced reconciliation and diagnostics export stay in [beta qualification](MACOS-APP.md).

## Verification

`verify-macos.sh` for every stage; `application` for stages 1, 3 and 4; `integration` for
stages 1 and 4; `browser desktop.spec.ts` for stage 1; `workflow` for docs. Stages 2 and 3
need a signed-app rehearsal: disable and re-enable the extension, and observe the warning
while `fileproviderd` is suspended with `kill -STOP`.
