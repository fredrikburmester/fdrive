# fdrive-owned shares

A proposed feature for S3 and WebDAV logins, and the provider seam that lets a storage type
opt into it. Not started. Builds on [provider development](../STORAGE-PROVIDERS.md) and the
current [share implementation](../../apps/api/src/shares/). Reviewed once against the source
on 2026-09-18; the review's findings are folded in below.

## Outcome

A person signed in to S3 or WebDAV storage selects files or a folder, chooses Share, and gets
the same public link as an SFTPGo login: password, expiry, download limit, list, download,
archive peek, zip and upload-only links. fdrive serves the link itself through the login's
storage. A storage type says how it shares with one word on its module, and the share routes,
the web app and the schema never learn which type backs a link.

## Current behavior

Shares are SFTPGo share objects. `createShare` creates one upstream with the owner's JWT and
`app.shares` keeps a row whose `sftpgoShareId` points at it. The share service refuses any
other provider type with `unsupported` (`owner()` in `apps/api/src/shares/service.ts`), so the
S3 and WebDAV modules keep `capabilities.shares` false and the web states the limit wherever
such storage is added, picked or browsed.

The owner's credential is already on the public path. Every public request loads the share
upstream with the owner's JWT (`loadPublic` → `getUpstream` → `withOwner`) and `layout()` stats
or lists with it too. Only the file bytes, the directory listing, zip and upload go through
SFTPGo's public share API, which enforces the password, expiry and `max_tokens`. The
architecture rule "never fall back to the owner's file credentials when public access fails"
is about those bytes.

What is provider-neutral today: the rate limiter, the sealed credential cookie, and the
`peekArchive` function, which reads `Pick<StorageProvider, "statFile" | "download">`. What is
not: the route layer. `routes.ts` imports `DownloadOptions`, `DownloadResult` and
`SftpgoError` from `@fdrive/sftpgo`, `publicCall` and `shareCall` map only `SftpgoError`, the
peek adapter takes `SftpgoPublicShareApi`, `unavailableReason` is typed on the live
`SftpgoShare`, the thumb route passes `sftpgoShareId` around, and the public download route
forwards a raw `Range` header string for SFTPGo to answer, including suffix ranges the
storage port has no shape for. Thumbnails come from the indexer cache, which only SFTPGo
storage has.

Trash is the precedent for a feature a backend either does itself or fdrive does for it:
`ProviderModule.trash` is `"native" | "move" | "none"`, and the API's storage factory composes
`withMoveToTrash` and `createRecycleFolderTrash` from `packages/core` around any
`StorageProvider` for `"move"`. Nothing in the trash routes knows a provider type.

## Proposal

### The provider seam: a share strategy per module

Add `ProviderModule.shares: ShareStrategy = "native" | "owned" | "none"` beside `trash`.

- `native`: the backend has its own public share objects and API. SFTPGo.
- `owned`: fdrive keeps the share and serves it through the module's `StorageProvider`. S3,
  WebDAV, and any future files-only backend that wants links.
- `none`: no shares. The capability flag is false and the routes refuse with `unsupported`.

`capabilities.shares` stays the type-level summary for System > Storage and the login form,
and must equal `shares !== "none"`. A new registry test asserts that for every module; no
such test exists for trash today, so this is a first. The provider service keeps passing the
flag through; nothing per row gates it in the first version.

A module opts in by changing one line. Adding a provider type in
[STORAGE-PROVIDERS.md](../STORAGE-PROVIDERS.md) then reads: implement the storage port,
declare `shares: "owned"`, done.

### The API seam: a management store and a per-request access object

The seam that removes every provider-type check from the share path is not one big backend
interface. It is two narrow pieces, chosen per identity from `module.shares`:

- A **management store**: `list`, `create`, `update`, `remove`, each returning
  `ManagedShare`. The native store is today's code moved: bound to the row's `baseUrl` and the
  owner's JWT, mirroring upstream state into `app.shares`. The owned store reads and writes
  rows only.
- A **`PublicShareAccess`**, built per public request after the row is loaded and the
  password, expiry and limit checks have run, shaped like
  `Pick<StorageProvider, "list" | "statFile" | "download" | "upload" | "zip">` plus a neutral
  `view` (`name`, `description`, `scope`, `paths`, `hasPassword`, `expiresAt`, `maxDownloads`,
  `usedDownloads`, `presentation`, `unavailableReason`) and `consume()`. The native
  implementation adapts `SftpgoPublicShareApi` the way the peek adapter already adapts two of
  its methods. The owned implementation wraps the owner's `StorageProvider` and confines it
  to the share's paths.

Routes, `peekArchive` and the streamed zip are then written once against port-shaped
methods. `publicCall`, `shareCall`, the peek adapter's SFTPGo type, `PublicThumbTarget.
sftpgoShareId` and the raw `Range` forwarding all go: ranges are parsed by fdrive into the
port's `{ start, end? }`, suffix ranges use `statFile` first as `fs/routes.ts` does, and 416
is answered by fdrive. Error mapping is per kind: the native access keeps today's mapping,
the owned access turns every upstream error into `upstream_unavailable`, so an `AccessDenied`
on the owner's key or a `reauth_required` from the credential store is never shown to a
visitor as a wrong password or a sign-in prompt. Password errors come only from fdrive's own
check.

The owner's storage comes from the existing identity storage factory, which already runs
without a session for MCP tokens, desktop tokens, retention and the indexer listener. It
returns storage wrapped with `withoutBackupPaths` and, when Trash is on, `withMoveToTrash`;
the wrappers are harmless for reads and wanted for uploads.

Whether the native store later moves into `packages/sftpgo` behind a module member is a
separate decision; a second native backend is what would justify it.

### Owned share data

One table, `app.shares`, no renames and no kind column. An owned row is one whose
`sftpgo_share_id` is null; a check constraint ties the new columns to that. Dispatch on a
loaded row follows the row, and the service refuses a row whose kind disagrees with the
identity's current module strategy, the way the trash service refuses a stored strategy the
module no longer allows.

| Column | Native | Owned |
| --- | --- | --- |
| `sftpgo_share_id` | SFTPGo's id, unique per identity | null |
| `name`, `scope`, `paths`, `expires_at`, `has_password` | mirrored | authoritative |
| `views` | cached `used_tokens` (the documented legacy name) | authoritative counter |
| `description`, `max_downloads`, `updated_at` | new, mirrored; `mirrored()` compares them, so every existing row is upserted once on its next listing | authoritative |
| `password_hash` | null | scrypt hash with its parameters, null when open |
| `presentation` | fdrive-owned today | same |

- `upsert` conflicts on `(identity_id, sftpgo_share_id)`, and Postgres never matches two
  nulls, so owned rows get their own `insert` and `updateOwned` repo methods, and the
  upstream-id validator becomes conditional.
- `password_hash` never rides on `ShareRecord`, which `managedShare()` spreads into API
  responses. It lives behind a separate repo projection used only by the credential check.
- The `packages/db` integration test that snapshots the exact column list and asserts that
  `upsert` strips extra properties is updated with the new columns and gains the assertion
  that the record projection has no `passwordHash`.
- `ManagedShare` and `PublicShare` do not change shape. `MAX_SHARE_DOWNLOADS` keeps SFTPGo's
  32-bit bound for both kinds so the dialog has one limit; its comment, which says the limit
  is stored by SFTPGo, is reworded.

Two rules in [ARCHITECTURE.md](../ARCHITECTURE.md) change wording, not intent. "Share passwords
are not persisted in the share database record" becomes "never in clear: native rows hold
nothing, owned rows hold a scrypt hash". "Never fall back to the owner's file credentials
when public access fails" stays for native bytes. For owned shares the owner's stored
credential is the only way to the bytes, so the rule becomes: an owned share reaches storage
only through the identity storage factory, only inside its paths, and only for the
operations its scope allows. [BACKUPS.md](../BACKUPS.md) gets one line: `password_hash` is in
the database backup, and owned rows restore fully while native rows depend on SFTPGo state.

### Enforcement moves to fdrive for owned shares

- **Password, checked once.** scrypt from Node's `crypto`, compared with `timingSafeEqual`.
  `POST /credentials` verifies eagerly and seals a verified marker plus a password version
  into the credential cookie, which is already AEAD-sealed and bound to the share id. Every
  later request costs one `open`, never a hash, so a bad cookie cannot spend CPU against the
  120-per-minute GET allowance; scrypt runs only under the 10-per-minute credential cap.
  Changing or removing the password bumps the version, which invalidates every cookie. The
  routes-level password cache stays for the native thumb route only.
- **Expiry.** `expires_at` checked before every operation, from the row.
- **Download limit.** `consume()` runs after `statFile` or `download` has succeeded with 200 or
  206, never before, so 404s, 416s, aborted requests and upstream failures spend nothing. One
  statement: `update ... set views = views + 1 where id = $1 and sftpgo_share_id is null and
  (max_downloads = 0 or views < max_downloads) and (expires_at is null or expires_at > now())
  returning ...`; a zero-row result is `limit` or `expired`. Read shares count file downloads,
  full-size previews and archive downloads, one each; write shares count uploads; thumbnails
  and HEAD never count. Same words as the rule recorded for native shares.
- **HEAD.** Hono dispatches HEAD as GET and discards the body without cancelling it. The
  public download route registers HEAD explicitly, answers from `statFile`, opens no stream
  and consumes nothing. `Accept-Ranges: bytes` is sent as the fs route does.
- **Confinement.** Every public path is normalized (catching the throw on a segment over
  255 bytes) and must resolve inside one of the share's paths. Read scope allows list, stat,
  download and zip. Write scope allows one upload into the single directory path and nothing
  else, matching today's upload-only links. Uploads overwrite an existing name, as native
  write shares do today; `overwrite: false` on S3 is a racy pre-check and would only make the
  two kinds differ. On create, paths under the provider's Trash root or the backup root are
  refused, and listings filter them, since the fs route hides the Trash path at the route
  layer and storage does not.
- **Concurrency.** Per-share caps on in-flight zips and open download streams, a wall-clock
  ceiling per response, and entry and byte ceilings on the zip walk. A single zip request is
  one limiter hit but can walk a whole S3 prefix and open one GET per file; WebDAV downloads
  have no timeout of their own.
- **Rate limit and CSRF.** Reused as they are. A disabled provider still classifies the share
  as known for the limiter, which is the right bucket.

### Serving without a native public API

| Operation | Owned implementation |
| --- | --- |
| Entries | `storage.list(path)` inside the share, Trash and backup paths filtered |
| Download | `storage.download(path, { range, ifRange, signal })` with fdrive's range parsing, `statFile` for suffix ranges and 416, `Content-Disposition` as today |
| Archive peek | `peekArchive` over the access object directly; the SFTPGo adapter stops being the only port user |
| Zip | new streaming code over `yazl`, the dependency `compress.ts` already carries; that module's temp-file, job-progress API is not reusable, only its cancel-sources pattern. No `Content-Length`, `Range` refused, cancellation propagated to the in-flight `download`, duplicate base names across several paths disambiguated the way `compress.ts` prefixes them, time and size ceilings |
| Upload | `storage.upload(join(paths[0], name), body, { contentLength })` under the existing byte cap |
| Thumbnails | none in the first version. `PublicThumbTarget` drops `sftpgoShareId` and takes a verify closure. The gallery falls back to the full image per tile for ordinary formats, and to an icon for HEIC and camera raw, so a HEIC folder on unindexed storage would be a grid of placeholders |

An owner whose provider is disabled or whose credential needs renewal makes the link answer
`upstream_unavailable`; the visitor sees "unavailable". There is no owner notification in the
first version: shares emit no system events today, and the owned Shares page lists rows
without probing storage.

### Web

- Copy comes from flags, never a type name. `FILES_ONLY_NOTE`, the Shares page's
  `unavailableNote`, the `MAX_SHARE_DOWNLOADS` comment and the `downloadLimited` comment in
  `presentation.ts` all name SFTPGo today and are reworded to "storage that can share" and to
  list only what the type really lacks. `isFilesOnly` stays `!index && !shares && !office`.
- Gallery on unindexed storage is enforced server-side, not just hidden. A row can already
  hold `presentation: "gallery"`, `auto` resolves to gallery on the client when every entry is
  an image, and a page is 200 tiles, each a 404 thumb plus a full download, against a
  120-per-minute limit. `publicMetadata` downgrades the presentation to `list` for owned rows
  (or `PublicShare` gains `thumbnails: false` and the client resolves from it), and the share
  dialog offers gallery only when the login has `index`. On-demand resizing with a small disk
  cache is a follow-up, not part of this.
- The public page's copy encodes SFTPGo's lazy check: "Access is checked when you browse,
  download, or upload" and "an upload share cannot be checked until something is uploaded".
  With eager verification the credential form reports a wrong password at once, including on
  write shares, and `credentialPresent` in `publicMetadata` (whose `verifiable` requires read
  scope today) follows the kind.
- The `publicRequests` e2e invariant (only `/api/v1/public/shares/`, never an identity header)
  does not change.

### Unlink and transfer

Unlink moves the login to a new account and revokes its API tokens; it does not delete the
identity, so shares of both kinds follow the login, and an owned link keeps serving with the
same stored credential under its new account. That matches native links, whose SFTPGo share
also survives. Keep parity and say so in [AUTH.md](../AUTH.md); revoking owned shares on
unlink is a separate decision if it is ever wanted.

### Delivery

Each pull request is shippable and dark until the last two flip a module:

1. `test(shares): cover the unsupported refusal for a non-SFTPGo login`. Nothing today
   proves the refusal survives a rewrite.
2. `refactor(shares): dispatch on a share strategy`. Adds `ShareStrategy`, the registry test,
   and replaces the type check with strategy dispatch. Behaviour-preserving.
3. `refactor(shares): serve public routes through a neutral access object`. The management
   store split and `PublicShareAccess` with the native adapter; routes, peek and error mapping
   rewritten against it; HEAD, fdrive-side range parsing, 416 and `Accept-Ranges`. Proven by
   the unchanged unit, integration and e2e suites plus the `shares-sftp` fetch spy.
4. `feat(db): owned share columns`. Additive migration, `insert` and `updateOwned`, the
   hash projection, validators, and the db integration cases including the column snapshot.
5. `feat(shares): owned read shares`. Owned store and access, eager password verification
   with the versioned cookie, expiry, consume-after-success, confinement with Trash and backup
   exclusion, and `/archive` refused cleanly for owned rows until the next step. Unit tests
   over `createMemoryStorage`, plus an API integration suite against MinIO through
   `composeApp` that injects `{ ...s3Module, shares: "owned" }` via `ProviderServiceDeps.
   modules`, since S3 stays `"none"` until step 7, with a fetch spy proving every byte goes
   through the S3 adapter and nothing reaches an SFTPGo endpoint.
6. `feat(shares): owned write shares and archive download`. Upload-only links, the streamed
   zip with its ceilings, and the per-share concurrency caps.
7. `feat(s3): shares: "owned"`. Flip the strategy, the flag-driven web copy, server-side
   gallery gating, the eager-check copy on the public page, and an e2e spec that links an S3
   login to alice as the Trash spec does and runs the shares walkthrough on it. Docs: S3, the
   provider guide's flag table and "Current limits", ARCHITECTURE and BACKUPS wording.
8. `feat(webdav): shares: "owned"`. The flip, its docs, and the WebDAV container suite.

## Decisions to make

- Password hashing with scrypt (no new dependency) rather than argon2, paired with eager
  verification and the versioned cookie. Recommended: yes.
- Gallery on unindexed storage: enforce `list` server-side and hide the option (recommended)
  or allow with the full-image cost and the placeholder tiles for HEIC.
- Whether an SFTPGo row may later choose `owned` over `native` as a per-server setting under
  System > Storage, like Trash. Not in this plan; deriving the kind from the null upstream id
  keeps the option open without a column.
- Path validation on create: mirror native, which stats only single-path shares for layout,
  and keep the shared 1000-path cap; bound the zip walk instead of the share. Recommended.
- Public uploads: overwrite as native does (recommended) or refuse an existing name for owned
  links only.

## Complete when

- An S3 login and a WebDAV login create, edit and revoke links; a signed-out visitor lists,
  downloads with a byte range and a suffix range, gets 416 for a bad one, peeks a zip,
  downloads an archive and uploads to a write-only link, and every request stays under
  `/api/v1/public/shares/`.
- Password, expiry and download limits are enforced by fdrive with tests for wrong password
  at the credential step, an old cookie after a password change, an expired link, an
  exhausted limit under concurrent downloads, HEAD spending nothing, and traversal outside the
  paths or into the Trash and backup roots.
- A visitor never reaches storage outside the share: cross-identity and cross-path isolation
  tests on the memory storage and on MinIO, and an upstream `AccessDenied` shown as
  unavailable, never as a password error.
- SFTPGo shares behave exactly as before, proven by the unchanged suites and the fetch spy.
- `docs/STORAGE-PROVIDERS.md` describes adding a backend with `shares: "owned"` as one line,
  and neither S3 nor WebDAV lists shares under "Not implemented".
