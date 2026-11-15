# Storage

The files folder ([`packages/local`](../packages/local/src/)) is fdrive's only storage:
`FDRIVE_STORAGE_ROOT`, one home per user at `<root>/<username>`. The API builds it once at
startup (`createFilesFolder`) and reaches files through the `StorageProvider` port in
`packages/core/src/ports/storage.ts`, which keeps routes, the web app and the indexer off
filesystem details and lets tests run on an in-memory storage. fdrive checks passwords itself
([authentication](AUTH.md)).

| Contract | Source |
| --- | --- |
| File operations and streams | [storage port](../packages/core/src/ports/storage.ts) |
| The files folder and its storage | [files folder](../packages/local/src/files-folder.ts), [home storage](../packages/local/src/storage-provider.ts), [shared folders](../packages/local/src/shared.ts) |
| The deployment's folder and its id | [files folder](../apps/api/src/local/files-folder.ts) |
| Per-request storage | [storage factory](../apps/api/src/auth/storage-factory.ts) |
| Trash | [Trash](../packages/core/src/trash/recycle-folder-trash.ts), [shared folders](../packages/local/src/shared.ts) |
| Name and health | [storage service](../apps/api/src/system/storage.ts) |

## Wiring

- `FDRIVE_STORAGE_ROOT` is required. `createFilesFolder` returns three functions:
  `storage(username)`, the user's home plus `/Shared with me` from `app.local_grants`
  ([shared folders](../packages/local/src/shared.ts));
  `admit(username)`, which refuses a disabled or removed user; and `health()`, whether the folder is this installation's (its marker, below) and
  one the API can read, write and enter.
- The files folder's id is the installation setting `storage.id`, created on the first start
  (`ensureStorageId`) and never changed: the Mac app compares it as each location's
  `providerId`, so a new one would have every Mac paired again. Migration 0045 carried it over
  from the files folder's old row in `app.providers`, and backups restore it with the other
  settings.
- A signed-in request's storage is built on first use from the username its session or token
  query read, already admitted ([authentication](AUTH.md#resolving-a-request)); outside a
  request the storage factory finds the identity and runs `admit` first.
- The storage's name is the installation setting `storage.name` ("Local folder" until an
  administrator renames it), trimmed, 1 to 120 characters. It shows under each username in the
  sidebar and as the Mac location's `displayName`. `GET /api/v1/system/storage` returns the
  name and the folder's health; `PATCH` renames it. System > General shows both.
- Share links are fdrive's own: it keeps them in `app.shares` and serves them through the
  owner's storage ([shares](../apps/api/src/shares/service.ts)).
- `Shared with me` is a reserved name at the top of every home: the path always means the
  folders others share with the user, listed only while something is shared, and nothing can be
  created, uploaded, moved, copied or renamed to it. A real folder of that name, made before
  the name was reserved or outside fdrive, stays on disk untouched and out of sight: listings,
  the index and folder sizes leave it out ([scoping](SCOPING.md#shared-folders-and-shared-with-me)).
  Rename it on the host to see it again.

## Installation flags

`/auth/me` carries the storage name and one flag the web reads, the same for every login:
`index`, the files folder is indexed: `FDRIVE_INDEXER_URL` is set and thumbnails, full-text or
image search is on ([scoping](SCOPING.md)). Everything else is always on: the files folder zips,
keeps modification times, moves in one step, shares links and folders, opens in Office, and has
a Trash.

## StorageProvider

Every member is required, and the files folder and the memory storage implement all of them:
`list`, `stat`, `statFile`, `probeDirectoryRead` (a live read proof), `contentStamp`,
`download`, `upload`, `uploadPart`, `mkdir`, `move`, `copy`, `deleteFile`, `deleteDir`,
`deleteEmptyDir`, which removes a folder only while it is empty (the files folder's `rmdir`), so
tidying up never takes what arrived meanwhile, `zip` and `trash`. `deleteFile` and `deleteDir`
delete for good; `trash.put(path)` moves an item into Trash and says where (`{ leaf, kind }`), and
every caller chooses.

Paths are the storage's own, already resolved from a scope. `stat` reports an entry (`EntryStat`):
its path and name as storage spells them, kind, size, modification time, extension and inode.
`statFile` is `stat` for a file only: `bad_request` on a directory, `not_found` on a missing
path. `upload`, `mkdir`, `move` and `copy` return the entry they made, so callers never stat it
again; `mkdir` also names the first folder it created (`created`, `null` when every folder was
there). `move`, `copy` and `upload` refuse a taken target with `conflict` unless
`overwrite: true`; callers never check a target first. `download` reports the body's length and
the file's modification time, and honours `range` with a 206 and `Content-Range`, and `ifRange`.
Storage keeps no content types: whatever serves a file types it from its name
(`mimeFromExtension`).
Every operation refuses a path through a symbolic link with `forbidden`; listings show the link
itself as kind `symlink`. Failures are `StorageError`s from core.

How the files folder implements it:

- **No symbolic links.** fdrive never creates one; writers outside it (SMB, rsync) may. Paths
  are normalized and joined to the home, and any operation whose path passes through a link,
  at any segment including the last, fails with `forbidden`, wherever the link leads
  ([home.ts](../packages/local/src/home.ts)). Everything fdrive checks about a path (grants,
  its own folders, share links) holds for the path as asked, so this one rule keeps web, MCP,
  AI, share links and the Mac out of Trash and `/.fdrive-desktop`. One `realpath` per call
  finds both links and the stored spelling; only when it differs from the path asked does an
  `lstat` per segment tell which. A listing shows a link as kind `symlink`, which nothing can
  open, download, move or delete, and a zip leaves it out. A shared folder is reached from its
  owner's home the same way, so a grant whose own path passes through a link is refused. The
  home itself, `<root>/<username>`, is the deployment's and may be a link.
- **Atomic publish.** Uploads and file copies write a temporary file beside the target and
  publish it with `link`, a real create-if-absent; only `overwrite: true` renames it over a
  taken name. A `durable` upload flushes the file to disk before publishing it and its folder
  after, so it survives a crash once the call returns; the Mac's staged uploads are durable.
  An upload's `critical` runs only the steps that change what is at its path (creating missing
  parent folders, publishing) inside the caller's critical section, after the body is staged:
  the file operations hold the path there, and never while a client's body arrives.
  `stat` reports the inode of a file or folder (`ino`), which a rename keeps.
- **Uploads in pieces.** The web app sends files over 8 MiB in 8 MiB pieces (`uploadPart` for
  each piece but the last, `upload` with `part` for the last; `/fs/upload` with `part`, `offset`
  and `final`). Each piece is written into
  `.fdrive-partial-<part>` at the top of the home (the owner's home for a shared folder), cut
  back to its offset first so a failed piece can be sent again, and the last piece publishes it
  as above. Every piece is checked like an upload; at startup the API removes parts older than
  a day.
- **Storage limits.** A user may have a limit (`app.local_users.storage_limit`, set in
  System > Users). Every upload, copy and move passes through the user's storage, which asks
  `LocalUsers.room` how much more the owner of the folder it lands in may hold: their limit
  less what the index counts in their home, Trash included. An upload is cut off once it
  passes that (a replaced file's bytes count as freed); a piece of an upload in pieces also
  counts the bytes the pieces before it wrote, which wait in the part unindexed. A copy, or a
  move into another owner's files, is refused when its files are larger. Both fail with
  `storage_limit_reached` (HTTP 507). A move within one owner's files adds nothing and is
  not checked. Usage comes from the index, so writes in flight together can briefly go
  over, and files the index has not seen yet do not count.
- **Copies** keep modification times. A link inside a copied folder is copied as the link it
  is, its target text unchanged, as a move takes it along: never followed, never its target.
- **Moves** are one `rename`, also between a user's files and a writable shared folder. The
  target is checked just before, since Node has no `RENAME_NOREPLACE`; a `link` and `unlink`
  would close that gap for files, but file watchers (the indexer's) would see a deleted file and
  an unfinished new one instead of a move. A `publish` move, for an entry fdrive staged where no
  watcher looks (the Mac's uploads), does exactly that for a new file, and flushes the new name
  to disk before returning. A target that is the source under another spelling,
  on a disk that ignores case, is a case-only rename, not a conflict.
- **Spelling.** On a disk that ignores case or accent encoding, `stat` and every write report
  the stored spelling as `path`, so links and lookups land on the name listings show.
- **Times** come from bigint stats everywhere, so a listing, a stat and a download agree on a
  file's modification time to the millisecond.
- **Downloads** send `Last-Modified` and no ETag; `ifRange` applies when it names the file's
  current second.
- **Stamps.** `contentStamp` reads a file's size, modification time, inode and change time from
  its open descriptor, none of its bytes. Office versions documents from it and requires it;
  the Mac's version checks use it to trust index rows.
- **Read proofs.** `probeDirectoryRead` opens a folder and reads one entry of it, no more.
- **Zip** streams with `yazl`, reading each file only as the archive is read, and reports files
  and bytes read once every file is counted (`onProgress`). Compressing to zip
  (`/fs/compress`) streams this zip straight into an upload of the archive.
- **Trash.** Each user's storage has its Trash at `TRASH_PATH`, `/.trash`, in core's layout
  (`createRecycleFolderTrash`); items live in `/.trash/.fdrive-move-v1`. `trash.put` refuses the
  root and fdrive's own folders. Something in a writable shared folder goes to its owner's Trash,
  at the owner's path, so `put` reports a leaf in the owner's files, which only the owner lists,
  restores and purges. Trash's one setting, how many days it keeps an item, is
  `trash.retentionDays` in `app.settings`, read at `/api/v1/trash/settings` and written at
  `/api/v1/system/trash`; the API's hourly retention deletes what is older ([Trash](TRASH.md)).
- **Ownership.** The API writes as `FDRIVE_RUN_AS_UID`, the uid the indexer and OCR use.
- **The folder's marker.** With a `guard` ([files-marker.ts](../packages/local/src/files-marker.ts)),
  the files folder serves files only while its `.fdrive-files` names this installation
  (`app.backup_configuration.installation_id`). The API and the backup worker build one
  (`createDeploymentFilesFolderGuard`); the API checks it at startup. A missing marker is
  written into a folder with entries, or any folder while the database has no live
  `idx.files` rows and no local users, and an empty marker is filled in. Otherwise every
  storage operation throws `upstream_unavailable` with the reason, `health` reports it on
  System > General, and `core` health fails. Sessions keep working: signing in, `/auth/me`
  and the System pages only read the database. The verdict is reused for ten seconds, and a
  database outage keeps a verified folder. The only other `upstream_unavailable` storage
  throws is EMFILE/ENFILE, when the process runs out of file descriptors.
- **Changes for the indexer.** Storage reports each change once it succeeds (`onChange`, a
  `DiskChange` by absolute path; [changes.ts](../packages/local/src/changes.ts)): an upload,
  copy, delete or new folder is `changed` (for `mkdir` with `parents`,
  the first folder it made, and nothing when every folder existed), and a move is `moved`.
  An upload's change carries the sha256 of the bytes written and the file's size, `mtimeNs`,
  inode and change time from a stat once it is published; when the published name no longer
  holds that inode, size and modification time, the change carries no content. A file
  renamed in place carries its stamp exactly as the rename left it and its change time just
  before (`MovedStamp`); a folder, a file copied to another filesystem, or one that changed
  between the two stats, carries none.
  Hashing runs only while something listens. The files folder turns these into paths relative
  to it (`onIndexChange`), and the API records them in the change journal, `idx.changes`, with
  source `api` (`createChangeQueue`, `createChangeWriter`), from its first start. A failed write
  is logged, never failing the request; see [how changes arrive](INDEXER.md#how-changes-arrive)
  and the [change journal](plans/CHANGE-JOURNAL.md).

## Tests

`describeStorageProvider(name, factory)` from `@fdrive/testkit` is the one conformance suite, with
no options and no skips: [the local suite](../packages/local/src/conformance.test.ts) runs it over a
temporary directory and testkit runs it over the memory storage, so both implement every member
the same way (the memory storage stores its zips uncompressed). `createMemoryStorage` from
`@fdrive/core/testing` is the application fake; do not add another. A test that stands in for one
call spreads it and overrides that call; `entryStat` builds what `stat` would report. API tests build the files folder over a temporary directory
(`filesFolderFixture` in the [local fixtures](../apps/api/src/local/test-fixtures/index.ts)) or
hand the storage factory a stand-in (`StorageSource`).
