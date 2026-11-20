# Architecture

Current implementation reference. Unfinished work belongs in [plans](plans/README.md).

## Boundaries

- Caddy serves one browser origin: Next.js UI, Hono API, MCP and optional Office integration.
  Deployment and network configuration live in [deploy](../deploy/README.md).
- `packages/core` defines storage/repository ports and shared domain operations.
  `packages/local` performs the file I/O; `apps/api` constructs it and handles authentication,
  authorization, HTTP, events and jobs. The UI uses the typed contracts client.
- `packages/db` owns Drizzle migrations for PostgreSQL's `app` metadata and `idx` index
  schemas. The indexer and OCR consume those schemas; they do not independently migrate them,
  and compose starts them once the API, which migrates before it serves, is healthy. History
  starts at `0000_baseline`, which replaced migrations 0000–0047. A new install runs it; a
  database v0.7.0-rc.11 or main's edge build left skips it, and `0001_squash_history` gives it
  the same schema and history. An older database is refused, unchanged, until it has run
  v0.7.0-rc.11.
- The indexer scans the files folder, extracts content and builds thumbnails/embeddings.
  The API records each change it makes in the change journal, `idx.changes`, and OCR each
  PDF it rewrites; the indexer reads the journal from its own position and applies them at
  once. Its file watcher and periodic scan cover changes made outside fdrive and journal them
  too, so the journal holds every change. See [how changes arrive](INDEXER.md#how-changes-arrive)
  and the [change journal](INDEXER.md#the-change-journal). The API reads the journal too, as the only
  way it learns of file changes: each change reaches every person who can see it once, as a
  resumable live update, and one made outside fdrive brings path-keyed metadata along (see
  [the API's reader](INDEXER.md#the-apis-reader)). OCR may write to mounted originals.
  Browser file operations go through the API, which reads and writes the files folder on its
  own disk. See [indexer](INDEXER.md), [OCR](OCR.md) and
  [search](SEARCH-AND-AI.md).
- Model inference and office-document text extraction run in the Rust
  [ML server](../services/ml/README.md). It has no database access and no storage mounts: the
  indexer and the API hand it bytes or text over HTTP, so parsing a hostile file cannot reach
  anyone's storage. It loads a model only while a feature that needs it is enabled.
- Optional AI organize calls Claude, Mistral or an OpenAI-compatible server from the API with
  read-only tools and returns suggestions the person applies through `fs/move-many`. See
  [AI](AI.md).
- fdrive serves a folder on its own disk (`FDRIVE_STORAGE_ROOT`, one home per user at
  `<root>/<username>`, plain files) and keeps its own users. That files folder is the only
  storage. Its plain files stay authoritative: fdrive keeps no database of their contents, and
  writers outside fdrive (OCR, rsync, SMB, Syncthing) may change them. fdrive never creates a
  symbolic link and never follows one: storage refuses a path through a link for every caller,
  and the indexer and OCR skip links. The API reaches it
  through the [storage port](STORAGE.md). `FDRIVE_STORAGE_ROOT` is required. End-to-end
  [encrypted folders](ENCRYPTION.md) hold only ciphertext under encrypted names: every storage is
  wrapped by a guard that refuses their contents to any route not on its allowed list, so share
  links, Office, AI, MCP, ZIP and the indexer's features never reach them. An installation-wide flag on `/auth/me` says whether the
  UI offers index-backed features: `index` (the files folder is indexed). Trash is always on.

## Accounts and storage

The optional [native macOS companion](MACOS.md) exposes File Provider domains, read-only by
default with explicitly granted writes on qualified storage. Each domain binds one
server/account/storage identity. Its versioned desktop API uses separate identity-bound
credentials; MCP tokens cannot retarget these domains.

An identity is a login (`app.identities`), and an account has exactly one
(`identities.account_id` is unique). A session and an API token act as that login
(`sessions.identity_id`, `api_tokens.identity_id`), and deleting the login ends them. Every
local user has a login of the same name (`identities.username`, unique in any case) from the
moment the user exists, and sign-in finds it by name in any case; passwords live only as
scrypt hashes in `app.local_users`. A removed user's login stays with its tags, shares and
activity, so the two tables join by name rather than by a foreign key. The files folder comes
from the deployment; its name and its id, which the Mac compares as `providerId`, are
installation settings (`storage.name`, `storage.id`), and administrators change the name on
System > General. See [authentication](AUTH.md) and [storage](STORAGE.md).

Local users are `app.local_users`: a username unique in any case, a scrypt hash, a disabled
flag and an optional storage limit ([storage](STORAGE.md#storageprovider)). Setup creates the
first one and System > Users the rest; a disabled user is refused on every request, not only at
sign-in, by the one query that resolves the request
([authentication](AUTH.md#resolving-a-request)). Folders shared between users
are `app.local_grants` (owner, folder path, grantee, read or write), served by
`/api/v1/grants`. The grantee's storage shows each at `/Shared with me/<name>` (the folder's
name, then `<name> (<owner>)` on a clash), confined to the owner's folder; `Shared with me` is
a reserved name at the top of every home, and a real folder of that name stays on disk out of
sight ([storage](STORAGE.md#wiring)); a read-only grant
refuses every change, and the grantee cannot rename, move or delete `Shared with me` or the
shared folders themselves. A move between a user's files and a writable shared folder is one
rename. Grants follow the owner's moves and deletes, made through fdrive or journaled by the
indexer's watcher, and index scopes follow the grants ([scoping](SCOPING.md)). A grant follows
its folder into the owner's Trash too, since that is a move like any other, so it never stays at a path a new folder can take; a
purge deletes it. Something in a writable shared folder that the person it is shared with
deletes goes to the owner's Trash, since it is the owner's file. Sharing refuses fdrive's own folders
(`isReservedPath`, below), and the grantee's storage and index scopes refuse a grant in the
owner's Trash or in the Mac's `/.fdrive-desktop` (`closedToShares`)
([Trash](TRASH.md)).

fdrive keeps its own places inside each user's files, and one rule in `@fdrive/core` names them
(`isReservedPath`): the Trash at `/.trash` and the Mac's `/.fdrive-desktop`
(`RESERVED_FOLDERS`), in any case.
Listings, the Mac, search, MCP and AI never show them; index queries leave them out in SQL
before their limit. The indexer never walks `/.fdrive-desktop`; it does index the Trash, so
moves into and out of it stay renames. OCR takes its PDFs from the index and leaves out all of these. Where a consumer differs it says so: links also never reach
`/Shared with me`.

Metadata uses identity plus canonical virtual path. fdrive changes files in one place, the
[file operations](../apps/api/src/files/operations.ts): upload, mkdir, move, copy, Trash,
restore and purge, for the web's file and Trash routes, MCP, AI chat, Office and a link's
visitors alike. Each records its intent in personal activity, runs its storage call in one
transaction with what grants access (grants, public links and Office files,
[access.ts](../apps/api/src/files/access.ts)), records the outcome, and then lets tags,
favorites, folder views, recents, chat references and the Mac's item handles follow, best
effort: a failure there is a warning, and nothing it keeps grants access. What grants access
fails closed. It changes before the storage call, so a refused change leaves the file where it
was and fails the request. Trash's rows (`app.trash_items`) change in the same transaction: a
delete writes its item's row first, as on its way, and the item arrives with what grants access;
a restore or a purge removes the row with them ([Trash](TRASH.md#where-deleted-items-live)).
The transaction holds each path the operation vacates, and an operation creating something
at or below one waits for it, so a new item never appears where a link or share still points.
Nothing is held while a client's body arrives: an upload stages its body first and holds its
path only to publish it.
A Mac write moves what grants access with its receipt instead. Moves made outside fdrive,
which the indexer's watcher journals, carry metadata along when the API reads the
[change journal](INDEXER.md#the-apis-reader); index paths must be translated through the
identity's scopes. A path
or content hash alone never grants another identity access. Public share links are fdrive's
own: fdrive keeps the share in `app.shares` and serves it through the owner's storage, which
the share reaches only through
the identity storage factory, only inside its paths, and only for the operations its scope
allows. Trash, `/Shared with me` and the Mac's `/.fdrive-desktop` are never reachable through a
link. A link follows the item it names
wherever it moves, so it never stays at a path where something new could appear: on every
route other path-keyed metadata follows, through the Trash and its restores, the Mac's
writes and moves the indexer's watcher journals. Inside a place no link reaches (Trash, say)
it shows not found, and it works again once the item comes back out. A move inside a folder shared with someone counts in the owner's
files; taken out of them, deleted, or purged from Trash, the item leaves its links, and a
link left with nothing goes.
Folder ZIP downloads are held to two at a time per link, an hour and `FDRIVE_JOB_MAX_BYTES`
([zip-limits.ts](../apps/api/src/shares/zip-limits.ts)), and each counts one download. A link
whose folder holds the owner's Trash, `/.fdrive-desktop` or `/Shared with me` cannot be
downloaded as an archive, nor can one whose paths overlap or would land on one name (compared
ignoring case); new links with several paths are refused on that last rule too.
Protected share metadata must not leak before authentication. Share passwords are never
stored in clear: a row holds only a scrypt hash in `password_hash`, which only the public
lookup reads, to verify a visitor, and no response carries; the owner sees `hasPassword`
(`password_hash is not null`). The public credential-cookie flow has separate protections. A
public request reads its share's row once, then works from it. A visitor's upload never
replaces a file: a taken name is refused by storage, and the upload lands on the next free
numbered name (`photo (2).jpg`), which the visitor is shown. See the API's
[share implementation](../apps/api/src/shares/service.ts).

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

## Database connections

The API keeps four pools ([pools.ts](../apps/api/src/pools.ts)), and work takes them in
this order:

1. **Office**: a save holds its document's lock, and a connection, while its body arrives.
2. **Write gate**: while backups are configured, a write holds the backups' snapshot gate,
   shared, for the short section where it changes the files folder or the database in more
   than one step, so no capture's snapshot sees half of it ([backups](BACKUPS.md#what-is-included)).
   A file operation holds it from its storage call to its last follower, an upload from its
   publish once its body is all here, and a Mac write for its commit (`WriteGate`). Nothing
   holds it while a client's body arrives.
3. **File operations**: a file operation's transaction holds the paths it changes while its
   storage call runs (a rename, a mkdir, an upload's publish, a whole copy).
4. **Main**: everything else, backups included.

Work holding a connection from one pool waits only for a connection from a pool after it, never
from its own or one before it. An Office save holds its Office connection while its upload
publishes, the publish holds the gate while its file operation takes a connection, the file
operation holds its connection while storage reads the main pool, and main pool work waits for
no other pool. A cycle of waits needs a holder that waits for its own pool or an earlier one,
so none forms however full the pools are; their sizes only set how much runs at once. Locks
keep to the same pools: a request waits for a document's lock with an Office connection, for
the gate with a write gate one and for a path's with a file operations one. A write inside
another joins it instead of taking a second gate connection. One kind of wait falls outside
this. A file operation or Office save can hold rows and locks that main pool work also takes (a
link's row, the Office registry's lock), and main pool work then waits until that transaction
commits. Every pool but the gate gives up on a connection after 30 seconds, so a cycle there
ends in a failed request, not a stuck API. The gate waits as long as the writes before it take:
none of them waits for anything a write waiting for the gate holds. `connection-pools.test.ts`
fills each pool with waiting work and checks the rest of the API still answers and everything
completes; with any of the three on the main pool, it fails. It also stalls more uploads than
the gate has connections, mid-body, and checks other writes and a capture go through.

The most connections each process opens at once, from `CONNECTION_BUDGET`. A test keeps the
total within Postgres's `max_connections`, which [compose](../deploy/compose.yaml) sets to
200, and checks the indexer's and OCR's numbers against their code.

| Process | Holder | At most |
| --- | --- | --- |
| API | write gate pool | 16 |
| API | Office pool | 10 |
| API | file operations pool | 10 |
| API | main pool | 10 |
| API | the change journal's `LISTEN` | 1 |
| Backup worker | its pool: its lock, a capture and their bookkeeping | 6 |
| Indexer | one per thread that reads the database: three pools of up to 16 workers (scan, journal, watcher; `MAX_WORKERS`), ten threads of its own and eight HTTP handler threads (`HTTP_BLOCKING_THREADS`) | 66 |
| OCR | a pass, the settings poll, one request on the event loop and two restores or deletes of kept originals (`ORIGINALS_AT_ONCE`) | 5 |
| Operator | `psql`, the backup commands | 10 |
| **Total** | of 200, 3 kept for superusers | **134** |

The API's and the worker's pools connect on first use and close idle connections after 10
seconds, so a quiet installation holds far fewer; the indexer keeps each thread's. The API's
are named `fdrive api <pool>` and the worker's `fdrive backup worker` in `pg_stat_activity`. A
capture taking its snapshot waits for running writes on one connection of its own pool: the
worker's, or main when the API runs the worker itself (`FDRIVE_BACKUP_WORKER`).

## UI and runtime decisions

- Feature activation is persisted through onboarding/System settings. Optional processing
  begins disabled; the ml service and the Office controller expose starting, ready and failed
  states.
- System pages are installation-wide and independent of the signed-in login, and every page
  header says so. System > General holds the server address, the files folder's name and
  health, and how long Trash keeps an item.
- Settings holds the signed-in login's own preferences, one page per section under `/account`:
  Appearance, Browsing, Formats, Password, Encryption and API tokens (`/account` opens the
  first). A wide screen lists the sections beside the open one; on a phone `/account` is the
  list and a section's URL is that section alone, decided in CSS from the URL. The routes keep
  the `/account` prefix from when the page was called Account.
- The admin sidebar shows live processing activity and percentages only for fixed workloads.
  Lightweight worker snapshots and one shared poll drive it; see [System activity](SYSTEM-ACTIVITY.md).
- Search combines text/filename and available visual results, with separate failure states.
  Image similarity by perceptual hash is not the shipped text-to-image search feature.
- Folder view mode and sort are pinned per identity/path in `app.folder_views`, with no
  inheritance and independently of each other (`mode` is null for a sort-only pin; a pin with
  neither part is deleted). `fdrive.view` and `fdrive.sort` remain the browser defaults; an
  unset view default is the list, or the tree with the beta file list. Virtual listings use
  those defaults; moves/deletes update pins.
- Browser preferences live under `fdrive.*` localStorage keys, are read through
  `useSyncExternalStore` hooks so every mounted consumer and other tabs update together, and
  are set in Settings (`/account`) or in the View menu: row click (`fdrive.list.rowClick`: select,
  toggle selection, highlight or open; highlight moves the focus ring and range anchor without
  changing the selection; modified clicks, Enter and double-click keep their meaning), list
  density (`fdrive.list.rowDensity`: 36px standard rows, the default, 64px comfortable rows
  with larger icons and thumbnails, or 30px compact rows), size units (`fdrive.format.sizes`), date style
  (`fdrive.format.dates`) and clock (`fdrive.format.clock`). Components render sizes and dates
  through `useFormatters`, never the bare formatters, so a preference applies everywhere.
  The desktop sidebar's width (`fdrive.sidebar.width`) is one of them, set by dragging the
  sidebar's edge. So is the file list design (`fdrive.list.design`, set in Settings only):
  classic, or a beta with folders that open in place, colored icons, a More button per row and
  checkboxes behind Select. The details panel (`fdrive.inspector.open`) is open by default
  where it fits beside the listing (1024px and up) and remembers a close; narrower windows
  show it as a sheet that never opens by itself and is not stored. It shows the selection, or
  the highlighted row when nothing is selected. The listing's tree view and the sidebar's folder tree remember their open folders
  apart (`fdrive.list.tree` and `fdrive.sidebar.tree`), and only the user opens a sidebar
  folder: navigating never expands it.
- The AI chat is a sparkle button in the files toolbar (`ChatToggle`, rendered by the file
  browser left of the details toggle) and an overlay under the page header at the top right
  that ends above the live activity dock; on narrow screens the panel is a sheet. The overlay
  is as tall as its content, so a new chat is only its header and composer. It is mounted in the
  shell layout, not inside the file browser, so it stays open between folders, and it renders
  only on folder pages, since the folder in view is what the assistant works on (sent as each
  message's `location`). Its open state, width and current chat are `fdrive.chat.open`,
  `fdrive.chat.width` and `fdrive.chat.current`, read through the same `useSyncExternalStore`
  pattern as the other browser preferences. Files and folders reach it by drag onto the panel
  or button (the listings' internal `application/x-fdrive-paths` drag) or **Add to chat** from
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

Public share `usedDownloads` (`app.shares.used_downloads`) is fdrive's own counter. Write
shares count uploads; read shares count downloads, archives, previews and peeks, each once
however many reads it takes, and a limited link previews and peeks like any other. Audio and
video, which a viewer streams in Range reads, are opened through the share
(`POST .../preview`): it counts the preview up front, refuses it once nothing is left, and
returns a token for that one file, that browser (an httpOnly visitor cookie on the share's
path) and five minutes, which the download URL serves without counting again. The token holds
no state: what it names is all it opens, and it opens nothing a full download by the same
visitor would not. Every other preview is one counted download; a download without a token
always counts. Thumbnails never count.

A Trash item's id is its row's id in `app.trash_items` and the name of its folder in
`/.trash`. Public System logs merge internal
`SystemEvent` rows with worker history. Share permission `scope` and index path
scopes are separate typed concepts.

WOPI locks accept opaque text file IDs and have a 30-minute TTL. The Office routes
resolve and authorize a durable Office file before accessing its lock; the generic
lock repository therefore has no UUID foreign key. Lock reads/writes prune up to
100 expired rows using the expiry index and skip rows another transaction holds.
The search indexes (trigram, full text and vector) are declared in Drizzle with the rest of
the schema, so the baseline migration creates them like any other index.
