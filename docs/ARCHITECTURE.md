# Architecture

Current implementation reference. Unfinished work belongs in [plans](plans/README.md).

## Boundaries

- Caddy serves one browser origin: Next.js UI, Hono API, MCP and optional Office integration.
  Deployment and network configuration live in [deploy](../deploy/README.md).
- `packages/core` defines storage/repository ports and shared domain operations.
  `packages/local` performs the file I/O; `apps/api` constructs it and handles authentication,
  authorization, HTTP, events and jobs. The UI uses the typed contracts client.
- `packages/db` owns Drizzle migrations for PostgreSQL's `app` metadata and `idx` index
  schemas. The indexer and OCR consume those schemas; they do not independently migrate them.
- The indexer scans the files folder, extracts content and builds thumbnails/embeddings.
  The API records each change it makes in the change journal, `idx.changes`, and OCR each
  PDF it rewrites; the indexer reads the journal from its own position and applies them at
  once. Its file watcher and periodic scan cover changes made outside fdrive and journal them
  too, so the journal holds every change. See [how changes arrive](INDEXER.md#how-changes-arrive)
  and the [change journal](plans/CHANGE-JOURNAL.md). OCR may write to mounted originals. Browser file operations go through the API, which reads
  and writes the files folder on its own disk. See [indexer](INDEXER.md), [OCR](OCR.md) and
  [search](SEARCH-AND-AI.md).
- Model inference and office-document text extraction run in the Rust
  [ML server](../services/ml/README.md). It has no database access and no storage mounts: the
  indexer and the API hand it bytes or text over HTTP, so parsing a hostile file cannot reach
  anyone's storage. It loads a model only while a feature that needs it is enabled.
- Optional AI organize calls Claude or an OpenAI-compatible server from the API with read-only
  tools and returns suggestions the person applies through `fs/move-many`. See [AI](AI.md).
- fdrive serves a folder on its own disk (`FDRIVE_STORAGE_ROOT`, one home per user at
  `<root>/<username>`, plain files) and keeps its own users. That files folder is the only
  storage. Its plain files stay authoritative: fdrive keeps no database of their contents, and
  writers outside fdrive (OCR, rsync, SMB, Syncthing) may change them. fdrive never creates a
  symbolic link and never follows one: storage refuses a path through a link for every caller,
  and the indexer and OCR skip links. The API reaches it
  through the [storage port](STORAGE.md). `FDRIVE_STORAGE_ROOT` is required. An installation-wide flag on `/auth/me` says whether the
  UI offers index-backed features: `index` (the files folder is indexed). Trash is always on.

## Accounts and storage

The optional [native macOS companion](MACOS.md) exposes File Provider domains, read-only by
default with explicitly granted writes on qualified storage. Each domain binds one
server/account/storage identity. Its versioned desktop API uses separate identity-bound
credentials; MCP tokens cannot retarget these domains.

The files folder is one row in `app.providers`; an identity is a login on that row, and an
account has exactly one (`identities.account_id` is unique). A session and an API token act as
that login (`sessions.identity_id`, `api_tokens.identity_id`), and deleting the login ends
them. Every local user has a login of the same name from the moment the user exists, and
sign-in finds it by name in any case; passwords live only as scrypt hashes in
`app.local_users`. The files folder's row comes from the deployment; its name is an
installation setting administrators change on System > General. See
[authentication](AUTH.md) and [storage](STORAGE.md).

Local users are `app.local_users`: a username unique in any case, a scrypt hash and a disabled
flag. Setup creates the first one and System > Users the rest; a disabled user is refused on
every request, not only at sign-in, by the one query that resolves the request
([authentication](AUTH.md#resolving-a-request)). Folders shared between users
are `app.local_grants` (owner, folder path, grantee, read or write), served by
`/api/v1/grants`. The grantee's storage shows each at `/Shared with me/<name>` (the folder's
name, then `<name> (<owner>)` on a clash), confined to the owner's folder; `Shared with me` is
a reserved name at the top of every home, and a real folder of that name stays on disk out of
sight ([storage](STORAGE.md#wiring)); a read-only grant
refuses every change, and the grantee cannot rename, move or delete `Shared with me` or the
shared folders themselves. A move between a user's files and a writable shared folder is one
rename. Grants follow the owner's moves and deletes made through fdrive, and index scopes
follow the grants ([scoping](SCOPING.md)). A grant follows its folder into the owner's Trash
too, since that is a move like any other, so it never stays at a path a new folder can take; a
purge deletes it. Something in a writable shared folder that the person it is shared with
deletes goes to the owner's Trash, since it is the owner's file. Grants and public links follow a move before
any other path-keyed metadata (`withFollowers`), so a failure in tags or favorites never leaves
them behind; a Mac write moves them with its receipt. Sharing refuses fdrive's own folders
(`isReservedPath`, below), and the grantee's storage and index scopes refuse a grant in the
owner's Trash, in fdrive's Trash layout or in the Mac's `/.fdrive-desktop` (`closedToShares`)
([Trash](TRASH.md)).

fdrive keeps its own places inside each user's files, and one rule in `@fdrive/core` names them
(`isReservedPath`): the Trash at `/.trash` and the Mac's `/.fdrive-desktop`
(`RESERVED_FOLDERS`), plus fdrive's Trash layout (`.fdrive-move-v1`) wherever it lies, all in
any case.
Listings, the Mac, search, MCP and AI never show them; index queries leave them out in SQL
before their limit. The indexer never walks `/.fdrive-desktop`; it does index the Trash, so
moves into and out of it stay renames. OCR takes its PDFs from the index and leaves out all of these. Where a consumer differs it says so: links also never reach
`/Shared with me`.

Metadata uses identity plus canonical virtual path. Application moves and indexer events
propagate renames; index paths must be translated through the identity's scopes. A path
or content hash alone never grants another identity access. Public share links are fdrive's
own: fdrive keeps the share in `app.shares` and serves it through the owner's storage, which
the share reaches only through
the identity storage factory, only inside its paths, and only for the operations its scope
allows. Trash, `/Shared with me` and the Mac's `/.fdrive-desktop` (which
holds its Trash) are never reachable through a link. A link follows the item it names
wherever it moves, so it never stays at a path where something new could appear: on every
route other path-keyed metadata follows, through the Trash and its restores, the Mac's
writes and moves the indexer reports. Inside a place no link reaches (Trash, say)
it shows not found, and it works again once the item comes back out. Anything in fdrive's
Trash layout (a `.fdrive-move-v1` segment) stays refused wherever it lies. A move inside a folder shared with someone counts in the owner's
files; taken out of them, deleted, or purged from Trash, the item leaves its links, and a
link left with nothing goes.
Folder ZIP downloads are held to two at a time per link, an hour and `FDRIVE_JOB_MAX_BYTES`
([zip-limits.ts](../apps/api/src/shares/zip-limits.ts)), and each counts one download. A link
whose folder holds the owner's Trash, `/.fdrive-desktop` or `/Shared with me` cannot be
downloaded as an archive, nor can one whose paths overlap or would land on one name (compared
ignoring case); new links with several paths are refused on that last rule too.
Protected share metadata must not leak before authentication. Share passwords are never
stored in clear: a row holds only a scrypt hash in `password_hash`, which no share record
projection returns; the public credential-cookie flow has separate protections. See the
API's [share implementation](../apps/api/src/shares/).

Session revocation follows the [authentication guide](AUTH.md#session-revocation).

Personal activity is separately owned by the initiating account, with the storage identity
captured alongside it. History never extends the
actorless administrator `system_events`. The append-only journal, file registry, copied
native receipts, read aggregation and Unknown observations are documented in
[personal activity](ACTIVITY.md).

## Index authorization

Use [scoping](SCOPING.md) when touching search, thumbnails, metadata events or MCP. A login's
scopes are its home in the files folder plus one per folder shared with it (`scopesFor`),
computed for each request and never from a path a client sends; an index row they map to is the
login's to see, with no storage read. The index has one root, the files folder, seeded as
`idx.roots` row 1. While the files folder is not indexed, logins keep ordinary file operations,
including explicitly scoped [MCP file tools](MCP.md).

## Office and recovery

Office uses durable file UUIDs keyed by owner and owner's path, session-bound tokens, callback
verification and explicit edit admission. See [Office implementation](OFFICE-DEVELOPMENT.md) and [setup](OFFICE.md).
Trash is a storage capability, not application-owned snapshot history; see [Trash](TRASH.md).

## UI and runtime decisions

- Feature activation is persisted through onboarding/System settings. Optional processing
  begins disabled; the ml service and the Office controller expose starting, ready and failed
  states.
- System pages are installation-wide and independent of the signed-in login, and every page
  header says so. System > General holds the server address, the files folder's name and
  health, and how long Trash keeps an item.
- The admin sidebar shows live processing activity and percentages only for fixed workloads.
  Lightweight worker snapshots and one shared poll drive it; see [System activity](SYSTEM-ACTIVITY.md).
- Search combines text/filename and available visual results, with separate failure states.
  Image similarity by perceptual hash is not the shipped text-to-image search feature.
- Folder view mode and sort are pinned per identity/path in `app.folder_views`, with no
  inheritance and independently of each other (`mode` is null for a sort-only pin; a pin with
  neither part is deleted). `fdrive.view` and `fdrive.sort` remain the browser defaults.
  Virtual listings use those defaults; moves/deletes update pins.
- Browser preferences live under `fdrive.*` localStorage keys, are read through
  `useSyncExternalStore` hooks so every mounted consumer and other tabs update together, and
  are set on the Account page or in the View menu: row click (`fdrive.list.rowClick`: select,
  toggle selection, highlight or open; highlight moves the focus ring and range anchor without
  changing the selection; modified clicks, Enter and double-click keep their meaning), list
  density (`fdrive.list.density`), size units (`fdrive.format.sizes`), date style
  (`fdrive.format.dates`) and clock (`fdrive.format.clock`). Components render sizes and dates
  through `useFormatters`, never the bare formatters, so a preference applies everywhere.
  The desktop sidebar's width (`fdrive.sidebar.width`) is one of them, set by dragging the
  sidebar's edge.
- The AI chat is a bubble in the live activity dock's corner that opens a floating panel above
  it, below the activity panel; on narrow screens the panel is a sheet. It is mounted in the
  shell layout, not inside the file browser, so it stays open between folders, and it renders
  only on folder pages, since the folder in view is what the assistant works on (sent as each
  message's `location`). Its open state, width and current chat are `fdrive.chat.open`,
  `fdrive.chat.width` and `fdrive.chat.current`, read through the same `useSyncExternalStore`
  pattern as the other browser preferences. Files and folders reach it by drag onto the panel
  or bubble (the listings' internal `application/x-fdrive-paths` drag) or **Add to chat** from
  a selection or row. Its transcript
  and composer are the trimmed AI Elements components under `components/ai-elements/`; the
  action cards and reference chips are fdrive's own.
- Use the existing UI tokens and components. Action labels omit ellipses; progress labels
  may use them. Keep transient failures from deleting persisted preferences.
- HEIC/HEIF files are stored as uploaded. The web client decodes them natively where the
  browser can (`<picture><source type="image/heic">`), shows the indexer's 1024px WebP
  thumbnail elsewhere, and decodes the full file in the browser on zoom or when no thumbnail
  exists (`heic-to/csp`, a wasm2js build that needs no CSP `eval` allowance), refusing files
  over 50 MiB before they are downloaded. A failed decode keeps the thumbnail on screen.
- Camera raw files (Sony ARW, Canon CR2/CR3, Nikon NEF, DNG and other LibRaw formats) are
  thumbnail-only. The indexer reads the JPEG preview the camera embeds through `rawler`,
  developing the sensor data only when no preview covers 1024px, and
  writes the usual WebP sizes. Raw extensions are `RAW_EXTS` in the indexer and
  `RAW_IMAGE_EXTENSIONS` in `@fdrive/contracts`; they never enter text extraction or OCR. No
  browser decodes raw, so grids, the inspector, the viewer and public galleries show the
  thumbnail and offer the original as a download; the file itself is never fetched to render.

## Verification

[AGENTS.md](../AGENTS.md) lists the required checks. Executable coverage
thresholds and CI configuration are authoritative; do not copy historic phase targets.
[Performance](PERF.md) describes the blocking harness and budgets.

## Interface names and persistence

Public share `usedDownloads` is fdrive's own counter; `app.shares.views` is its legacy column
name. Write shares count uploads;
read shares count downloads and full-size previews. Thumbnail views do not consume
that budget. Names remain compatible with existing clients and stored data.

A `TrashEntry.id` is an opaque provider entry identifier; the recycle-folder adapter
uses its path relative to the trash root. Public System logs merge internal
`SystemEvent` rows with worker history. Share permission `scope` and index path
scopes are separate typed concepts.

WOPI locks accept opaque text file IDs and have a 30-minute TTL. The Office routes
resolve and authorize a durable Office file before accessing its lock; the generic
lock repository therefore has no UUID foreign key. Lock reads/writes prune up to
100 expired rows using the expiry index and skip rows another transaction holds.
The five migration-created search indexes are also declared in Drizzle so schema
comparison preserves them; migration 0005 registers existing indexes idempotently.
