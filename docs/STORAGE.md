# Storage

The files folder ([`packages/local`](../packages/local/src/)) is fdrive's only storage:
`FDRIVE_STORAGE_ROOT`, one home per user at `<root>/<username>`. The API builds it once at
startup (`createFilesFolder`) and reaches files through the `StorageProvider` port in
`packages/core/src/ports/storage.ts`, which keeps routes, the web app and the indexer off
filesystem details and lets tests run on an in-memory storage. fdrive checks passwords itself
([authentication](AUTH.md)).

| Contract | Source |
| --- | --- |
| File operations, streams and optional members | [storage port](../packages/core/src/ports/storage.ts) |
| The files folder and its storage | [files folder](../packages/local/src/files-folder.ts), [home storage](../packages/local/src/storage-provider.ts), [shared folders](../packages/local/src/shared.ts) |
| The deployment's folder, its row and index root | [files folder](../apps/api/src/local/files-folder.ts) |
| Per-request storage and Trash | [storage factory](../apps/api/src/auth/storage-factory.ts) |
| Name and health | [storage service](../apps/api/src/system/storage.ts) |

## Wiring

- `FDRIVE_STORAGE_ROOT` is required. `createFilesFolder` returns three functions:
  `storage(username)`, the user's home plus `/Shared with me` from `app.local_grants`;
  `admit(username)`, which refuses a disabled or removed user; and `health()`, whether the folder is this installation's (its marker, below) and
  one the API can read, write and enter.
- The files folder is one row in `app.providers` (`type` and `base_url` `local`). Startup
  ensures it and keeps its id (`ensureStorageRow`); every login names it. The id never
  changes: the Mac app compares it as each location's `providerId`, and Office documents name
  it. Rows left from storage fdrive no longer has stay until the schema
  is collapsed; nothing reads them.
- A signed-in request's storage is built on first use from the username its session or token
  query read, already admitted ([authentication](AUTH.md#resolving-a-request)); outside a
  request the storage factory finds the identity and runs `admit` first. Either way it adds
  the Trash wrappers.
- The storage's name is the installation setting `storage.name` ("Local folder" until an
  administrator renames it), trimmed, 1 to 120 characters. It shows under each username in the
  sidebar and as the Mac location's `displayName`. `GET /api/v1/system/storage` returns the
  row's id, the name and the folder's health; `PATCH` renames it. System > General shows both.
- Share links are fdrive's own: it keeps them in `app.shares` and serves them through the
  owner's storage ([owned.ts](../apps/api/src/shares/owned.ts)).

## Installation flags

`/auth/me` carries the storage name and one flag the web reads, the same for every login:
`index`, the files folder is read under a root in `FDRIVE_INDEX_ROOTS` ([scoping](SCOPING.md)).
Everything else is always on: the files folder zips, keeps modification times, moves in one
step, shares links and folders, opens in Office, and has a Trash.

## StorageProvider

Required: `list`, `stat`, `statFile`, `download`, `upload`, `mkdir`, `move`, `copy`,
`deleteFile`, `deleteDir` and `deleteEmptyDir`, which removes a folder only while it is empty
(the files folder's `rmdir`), so tidying up never takes what arrived meanwhile. Optional members
are absent, never throwing, and agree with the flags: `probeDirectoryRead` and `probeFileRead`
(live read proofs), `setModifiedAt`, `zip` and `trash`.

Paths are the storage's own, already resolved from a scope. `statFile` throws `bad_request` on a
directory and `not_found` on a missing path. `move`, `copy` and `upload` refuse a taken target
with `conflict` unless `overwrite: true`; callers never check a target first.
`download` honours `range` with a 206 and `Content-Range`, and `ifRange`.
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
  `stat` reports the inode of a file or folder (`ino`), which a rename keeps.
- **Uploads in pieces.** The web app sends files over 8 MiB in 8 MiB pieces (`upload` with
  `part`; `/fs/upload` with `part`, `offset` and `final`). Each piece is written into
  `.fdrive-partial-<part>` at the top of the home (the owner's home for a shared folder), cut
  back to its offset first so a failed piece can be sent again, and the last piece publishes it
  as above. Every piece is checked like an upload; at startup the API removes parts older than
  a day.
- **Copies** keep modification times. A link inside a copied folder is copied as the link it
  is, its target text unchanged, as a move takes it along: never followed, never its target.
- **Moves** are one `rename`, also between a user's files and a writable shared folder. The
  target is checked just before, since Node has no `RENAME_NOREPLACE`; a `link` and `unlink`
  would close that gap for files, but file watchers (the indexer's) would see a deleted file and
  an unfinished new one instead of a move. A `publish` move, for an entry fdrive staged where no
  watcher looks (the Mac's uploads), does exactly that for a new file, and flushes the new name
  to disk before returning. A target that is the source under another spelling,
  on a disk that ignores case, is a case-only rename, not a conflict.
- **Spelling.** On a disk that ignores case or accent encoding, `stat` reports the stored
  spelling as `path`, so links and lookups land on the name listings show.
- **Downloads** send `Last-Modified` and no ETag; `ifRange` applies when it names the file's
  current second.
- **Stamps.** `contentStamp` reads a file's size, modification time, inode and change time from
  its open descriptor, none of its bytes. Office versions documents from it and requires it;
  the Mac's version checks use it to trust index rows.
- **Read proofs** open nothing: `probeFileRead` asks `access(R_OK)` and then checks for a
  regular file, the checks `download` makes, and fails with the kinds `download` would.
- **Zip** streams with `yazl`, reading each file only as the archive is read, and reports files
  and bytes read once every file is counted (`onProgress`). Compressing to zip
  (`/fs/compress`) streams this zip straight into an upload of the archive.
- **Trash.** The storage factory wraps the storage with core's `withMoveToTrash` and
  `createRecycleFolderTrash` at `TRASH_PATH`, `/.trash`; deleted items live in
  `/.trash/.fdrive-move-v1`. Its one setting, how many days it keeps an item, is
  `trash.retentionDays` in `app.settings`, read at `/api/v1/trash/settings` and written at
  `/api/v1/system/trash`; the API's hourly retention deletes what is older
  ([Trash](TRASH.md)).
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
  copy, delete, new modification time or new folder is `changed` (for `mkdir` with `parents`,
  the first folder it made, and nothing when every folder existed), and a move is `moved`.
  An upload's change carries the sha256 of the bytes written and the file's size, `mtimeNs`,
  inode and change time from a stat once it is published; when the published name no longer
  holds that inode, size and modification time, the change carries no content. A file
  renamed in place carries its stamp exactly as the rename left it and its change time just
  before (`MovedStamp`); a folder, a file copied to another filesystem, or one that changed
  between the two stats, carries none.
  Hashing runs only while something listens. The files folder turns these into paths under the index root (`onIndexChange`), and the
  API records them in the change journal, `idx.changes`, with source `api`
  (`createChangeQueue`, `createChangeWriter`) only when a configured root's `storagePath` is
  the files folder itself (`journalRoot`). A failed write is logged, never failing the
  request; see [how changes arrive](INDEXER.md#how-changes-arrive) and the
  [change journal](plans/CHANGE-JOURNAL.md).

## Tests

`describeStorageProvider(name, factory, options)` from `@fdrive/testkit` is the shared
conformance suite; [the local suite](../packages/local/src/conformance.test.ts) runs it over a
temporary directory. `createMemoryStorage` from `@fdrive/core/testing` is the application fake;
do not add another. API tests build the files folder over a temporary directory
(`filesFolderFixture` in the [local fixtures](../apps/api/src/local/test-fixtures/index.ts)) or
hand the storage factory a stand-in (`StorageSource`).
