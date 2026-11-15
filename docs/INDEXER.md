# The indexer

Per-file failures for thumbnails, text extraction and embeddings are persisted in
PostgreSQL, with recovery and retry controls in System. See
[persistent failure details](SYSTEM-ACTIVITY.md#persistent-failure-details).
`INDEXER_LOG_DIR` optionally retains timestamped diagnostic output as `indexer.log` and
four rotated files, 10 MiB each, alongside stdout. Deployment mounts a persistent named
volume there; standalone workers must configure a writable directory to retain these logs.

> [!TIP]
> **Looking to configure or use search in fdrive?** See the simple user guide in **[docs/SEARCH-AND-AI.md](SEARCH-AND-AI.md)**. This document is a technical reference for developers on the indexing service.

`services/indexer` is a Rust program (`fdrive-indexer`) that walks and watches the files
folder, mounted at `/data`, keeps `idx.files` / `idx.chunks` / `idx.folders` current, and
generates thumbnails. It
replaced a Python service of the same behaviour and keeps its HTTP API, database writes,
events and thumbnail layout, so existing index data stays valid. It never creates or migrates
its own schema: `packages/db`'s Drizzle migrations own `idx.*` and
`app.thumbnails` / `app.settings`. Compose starts it once the API is healthy, and the API runs
every migration before it serves, so the schema is there when it starts.

The `ml` service is one base URL, `ML_URL` (`http://ml:8080` by default): the indexer calls its
document extraction unit at `<ML_URL>/extract`, text embeddings at `<ML_URL>/text` and image
embeddings at `<ML_URL>/image`.

See [architecture](ARCHITECTURE.md) for the service boundaries.

## What is indexed

Every regular file in the files folder, except:

- Names in `SKIP_NAMES` (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `.localized`),
  AppleDouble sidecars (`._*`) and uploads local storage is still writing
  (`.fdrive-partial-<16 hex>`, renamed to the real name once complete).
- Directories in `SKIP_DIRS` (`.fdrive-desktop`, `@eaDir`, `.Trash`, `.Trashes`,
  `node_modules`, `.git`), wherever they lie. `.fdrive-desktop` is the Mac app's
  folder (its staged uploads), so none of it is indexed or journaled; the next scan sweeps rows indexed there before. fdrive's own Trash is
  indexed, so moving an item into and out of it stays a rename that keeps its thumbnails and
  embeddings; every index read leaves it out instead (see [search](SEARCH-AND-AI.md)).

A walk (a scan, a queued folder, a folder the watcher saw appear) never follows a link below
its starting folder, and the watcher never watches or indexes one. On network and FUSE storage such as Unraid's `/mnt/user` every look at a
folder or file is a round trip, so while the walking thread works through one folder, eight
reader threads (`walk.rs`) list and look at the folders that come next. Files still arrive
in one order: a folder's files by lowercase name, then each of its folders, depth first. A
folder listing already says what is a folder, a link, a pipe or a device, so only files are
looked at, for their size and time.

For each file the indexer records size, mtime, a sha256, a guessed MIME type,
and (for textual extensions) extracted text, chunked and embedded. Extraction
follows filesai's rules exactly:

| Extension group | How | Notes |
| --- | --- | --- |
| `.pdf` | MuPDF, page by page | Encrypted PDFs and pages beyond `MAX_PDF_PAGES` are skipped. With `searchOcr` on, pages without a text layer are OCR'd. Under 40 characters of text counts as `no_text`, or `disabled:search_ocr` while OCR is off (the nightly OCR job in `services/ocr` fills these in later). |
| Images (`.jpg`, `.png`, `.tif`, `.heic`, `.heif`, …) | Tesseract OCR | Only under paths matching `indexer.ocr_image_globs` (see Settings below); everything else is `excluded:image_dir`. With `searchOcr` off they are `disabled:search_ocr`. |
| Plain text / code (`.txt`, `.md`, `.py`, …) | Read directly, multiple encodings tried | Capped at `PLAIN_TEXT_CAP` characters. |
| Office documents (`.docx`, `.xlsx`, `.pptx`, `.odt`, …) | The `ml` service's extraction unit | Formats it does not read (iWork, legacy Visio, Publisher, WordPerfect) are `error:unsupported`; see the [ML server](../services/ml/README.md). |
| Anything else | Not extracted | `text_status = 'none'`. |

Text is chunked 1200 characters with a 200 character overlap
(`CHUNK_CHARS` / `CHUNK_OVERLAP`), capped at `MAX_CHUNKS_PER_FILE` (400) except
spreadsheets, which cap at 40: a few dozen chunks capture the labels in a
spreadsheet without drowning search results in numeric noise. Chunks are
embedded with the `passage:` prefix by the `ml` service's text unit
(`intfloat/multilingual-e5-small`, 384 dimensions, the same model filesai used,
so an imported index needs no re-embedding).

For a file that gets an image thumbnail (below) and is within `THUMB_MAX_MB`, the row also
holds the photo's EXIF details (`photo.rs`): when it was taken (the camera's clock, no time
zone), the camera, its size as shown and its GPS coordinates, each null when missing. The API
serves them to the Info panel and the Photos page; files indexed before this need a reindex.

Additionally, images, the first page of PDFs, and one frame of videos (via
ffmpeg, at 1 second in, or the first frame for shorter clips) get thumbnails at
256px and 1024px on the longest side,
written as WebP under `THUMBS_DIR/<sha[:2]>/<sha>.<size>.webp` and recorded in
`app.thumbnails`, keyed by the file's sha256 so identical files never generate
the same thumbnail twice. Being keyed by content, thumbnails and image embeddings (below)
outlive the rows that used them: the same bytes uploaded again, or the new file of a move
the watcher saw as a delete and a create (see [how changes arrive](#how-changes-arrive)),
find them again. Nothing collects the ones no file uses any more; clearing them (see
[clearing derived data](#clearing-derived-data)) empties the whole cache. Thumbnail
failures are logged once and never fail the file's own indexing; the image-embedding pass
that follows skips a file whose 256px thumbnail was never written without logging a second
error for it. Scans do not retry a failed thumbnail until the file changes or thumbnails are
turned on again; System can retry it sooner.

The api serves this same cache twice: `GET /api/v1/thumb` for the logged-in
file browser, and `GET /api/v1/public/shares/:id/thumb` for a public share's
gallery tiles. Both read straight from `FDRIVE_THUMBS_DIR`; neither ever goes
through the storage's own file download, so loading a gallery of thumbnails
never consumes a share's download limit the way opening or downloading a
full-size image does. The public route checks a password-protected share's
password before it serves a thumbnail. Both map index paths to a login's paths
through [scopes](SCOPING.md), which are the permission: neither reads the file. Responses
are cached privately and revalidated against the file's sha256 `ETag`.

`POST /thumbnails/rebuild` (`maintenance.rs`) is a separate, thumbnail-only
pass for when the WebP files themselves need regenerating, for example after
changing thumbnail sizes or quality, without paying the cost of a full
reindex (re-extraction and re-embedding). It walks `idx.files` rather than the
filesystem, filters down to thumbnailable extensions with the same rules as
above, and, with `force`, deletes the existing WebP files first so both sizes
are always rewritten; without `force`, existing ones are left alone and only
missing sizes are filled in. It runs in a background thread (at most one at a
time process-wide) and its progress is visible at `GET /stats` under
`thumbnail_rebuild`.

A file succeeds only when both thumbnail sizes are available and their database
rows are saved. Missing or undecodable sources and partially generated thumbnails
increment `errors`; the pass continues with other files. Empty files and files
over the `THUMB_MAX_MB` limit are skipped with a reason. Videos without a video stream
are skipped too; ffprobe has read those files, so the skip also resolves an earlier
thumbnail failure. Activity `processed` includes those skips, and `skipped` counts them
separately; generation errors include the number of sizes available in the worker log.
Sources over 178.9 million pixels (twice Pillow's limit, which the Python indexer used) are
refused, except a JPEG whose reduced-scale decode fits, such as a camera panorama.

### Image embeddings (optional)

While image search is on, with the `ml` service's image unit (a SigLIP 2
CLIP-style model, `google/siglip2-large-patch16-256`, 1024
dimensions), the indexer embeds the **256px thumbnail** it already wrote for
every image file (never the original) and stores the vector in
`app.image_embeddings`, keyed by the file's sha256 (`content_key`, the same
key `app.thumbnails` uses) so two copies of one photo are embedded once.

The pass follows thumbnail generation (`indexer.rs`'s `embed_thumbnail`,
called once a thumbnail is written). Retries embed inline. A scan hands
embeddings to a thread of its own, and watcher and journaled changes share one
long-lived thread, because the model runs one inference at a time and waiting
inline would pace every worker, and every later change, at the model's speed. Before writing anything, it checks the unit's `GET /health`
against the column's fixed dimension (1024) and an `"ok"` status, reusing a
passing answer for 30 seconds; on a
mismatch it logs an error naming both numbers and skips embedding for that
file without writing (never truncating, padding, or otherwise coercing the
vector). A file already embedded by the currently configured model is
skipped; one embedded by a different (stale) model is always re-embedded, so
a model change self-heals as files are next touched.

`POST /image-embeddings/rebuild` (`maintenance.rs`) is the bulk
backfill/rebuild pass, mirroring `/thumbnails/rebuild`'s shape: `{ path?,
force? }`, batched against the unit at `IMAGE_EMBED_REQUEST_BATCH_SIZE`
requests per call. Without `force`, only images with no row at all are
filled in; a row from a different model is left alone. With `force`, a
stale-model row is also re-embedded and overwritten, the deliberate "replace
the old model's rows" pass. A row already matching the configured model is
never redundantly recomputed either way. Progress is visible at `GET /stats`
under `image_embedding_rebuild`, and it shares the thumbnail-rebuild
admission lock (only one heavy background pass runs at a time).

## `text_status` values

| Status | Meaning |
| --- | --- |
| `pending` | Row exists, not yet processed by this cycle. |
| `indexed` | Text extracted, chunked, and (if the embedding service was reachable) embedded. |
| `partial` | Text extracted and chunked, and searchable by full text, but not embedded yet: the embeddings are on their way (watcher and journaled changes) or failed and are retried on the next scan. |
| `no_text` | Extraction, including OCR for images and PDFs, found too little text to be useful. Not retried until the file changes. |
| `disabled` | Skipped while a feature was off: `disabled:text` (`textSearch`), `disabled:search_ocr` (`searchOcr`, for images and PDFs without a text layer). Turning the feature on processes each row once. |
| `empty` | The file itself is empty. |
| `none` | Extension is not one the indexer knows how to extract. |
| `excluded` | Skipped by a rule: `excluded:prefix` (`indexer.text_exclude_globs`), `excluded:image_dir` (outside `indexer.ocr_image_globs`), `excluded:too_big`. |
| `error` | Extraction raised; the reason is in the row's `error` column. |

The admin **Logs** sheet on System > Indexer lists these `error` rows together with
`idx.scans` history and API-side events (settings saves, reindex and clear requests).

## Folders

`idx.folders` holds one row per folder a walk descends into (`path`, `name`, `mtime_ns`),
empty folders included, so search can find a folder by its own name. Skipped folders
(`SKIP_DIRS`, junk names) and everything below them get no row. The rows follow the same
three paths as files:

- a scan writes every folder it walked and, once its walk completed, drops the rows of
  folders it no longer found;
- a journaled folder records itself, the folders above it and those in it, and drops the rows
  of folders below it that are gone; a journaled file records the folders above it;
- the watcher records a new folder and those in it once its events settle;
- deleting or renaming a path deletes or renames its folder rows in the same transaction as
  its file rows.

Rows are rebuilt by the next scan, so backups leave them out.

## Name index

Search finds a name typed with a typo through the name index (`names.rs`): the name of every
`idx.files` and `idx.folders` row in a [Tantivy](https://github.com/quickwit-oss/tantivy)
index held in memory. Postgres stays the source of truth, so the index needs no volume and no
migration. A `names` thread builds each root from the tables when the indexer starts and again
after every completed scan and index clear. In between, every write of a name row (a file
indexed, a path deleted or moved, a folder row added or dropped, a scan's sweep) reports its
paths to the thread, which reads those rows again and commits them together about 100 ms
after the last change. A root with more than 2,000 changed paths waiting, as during a first
scan, is rebuilt whole instead. On a database error the thread rolls back and rebuilds the
roots involved once the database answers, waiting up to a minute between tries. A million
names take about 30 MB.

A query word must start a word of the name within its typo budget: none below five letters,
one up to eight and two from nine, a swap of two neighbours counting once (`typoBudget` in
`packages/core` counts the same way). One-letter words are left out while the query has longer
ones. Fewer typos, then a newer modification time, rank first; the API ranks the hits again
with its own rules.

## How changes arrive

Three paths lead to the same per-file processing, fastest first. Every change ends up in the
change journal, `idx.changes`: one numbered record of file changes that other parts of fdrive
read from their own position (see the [change journal plan](plans/CHANGE-JOURNAL.md)).

1. **The change journal.** fdrive's API writes the files folder, apart from OCR and the
   host's own tools. After each change it makes (an upload, a move or rename, a copy, a
   delete, Trash and restore, an Office save, a new folder) it
   appends a row to `idx.changes` with source `api` and sends `NOTIFY idx_changes` with the
   root's name (`createChangeJournal` in `packages/db`, fed by local storage's change
   listener). The OCR service does the same, with source `ocr`, when it replaces a PDF with
   its searchable version or puts a kept original back (`journal_change` in
   `services/ocr`), with a row for that file and no content hint, so search has the new text
   layer without waiting for the scan. Every writer takes the journal's advisory lock before
   inserting, so positions commit in order. A row without `target_path` says "look at `path`
   again"; with it, `path` moved there. An upload's row carries the sha256 the API computed
   while writing it and the size, `mtime_ns`, `inode` and `ctime_ns` of the file exactly as
   a stat showed it once published, so the indexer neither hashes nor reads the file while
   it is still that file. A client chooses an upload's modification time, but no client sets an inode or a
   change time, so a different file with the same size and time is always hashed: its bytes
   never key thumbnails or embeddings under another file's digest. A file move's row carries
   the same four for the file exactly as the rename left it, its change time just before
   (`previous_ctime_ns`) and no digest, so the row's [stamp](#stamps) can follow it. Where the API and the indexer see
   different inode numbers, neither ever matches. A `work-files` thread
   listens on the channel, looks every 30 seconds without it, and applies the rows
   after its position, oldest first, saving its position in `idx.change_cursors` (consumer
   `indexer`) after each batch:
   - a file is indexed on one of `indexer.workers` workers;
   - a folder is compared with its rows, like a scan of just that folder: new and changed
     files are indexed, and rows of files no longer there are dropped;
   - a missing path, or one a walk skips (a link, a skipped folder or name), has its rows
     and those below it deleted;
   - a move renames rows in place (a changed extension is a delete and a new file), carries
     a moved file's stamp along (below), then compares the destination with the disk, which
     covers a restore from somewhere the index never looked.

   What is on disk when a row is applied decides, as for the watcher, and moves and
   deletes wait for the files queued before them, so a batch applied again after a restart
   does no harm. On its first start the indexer begins at the journal's end; without a
   position it scans at start (below), which covers what came before. It passes over
   `watcher` and `scan` rows, which it wrote itself after applying them, and applies `api`
   and `ocr` rows. While indexing is off its position moves past rows without applying them
   (turning it on starts a scan). The API drops rows older than 30 days; when rows after the
   indexer's position were dropped before it read them, it scans the root and continues from
   the end.
2. **The watcher** (inotify, Linux only) sees changes made on the disk directly, for
   example over SMB, after a 2-second debounce. It sees fdrive's own changes too; whichever
   comes second finds the row current and does nothing, apart from stamping it when the
   first left it without a stamp (below). What
   it applies is journaled with source `watcher`: a file indexed as new or changed, a path
   whose rows it deleted, a move it paired (empty folders included) and each folder row it
   added or dropped. When it applies an API change before the indexer reads the API's row,
   the change is journaled twice; readers treat rows as "look again", so that is harmless.

   Only a rename the kernel reports as one (a `MOVED_FROM` and `MOVED_TO` with the same
   cookie, within the debounce) is a move: the file's row moves with its digest, text and
   stamp, and the API moves its tags, favorites and other path-keyed metadata
   ([below](#the-apis-reader)). Any other move, such as a copy and a delete over SMB, is a
   delete and a new file: the old row and its chunks are deleted and the new file is indexed
   from scratch, reusing thumbnails and image embeddings by its digest. The old path's
   metadata is dropped, never guessed onto the new one.
3. **The scan** walks the whole root every `indexer.scan_interval_seconds` (an hour by
   default), when settings or features change, after a watcher overflow and when the
   journal's reader asks for one, and catches anything the other two missed. A restart keeps
   counting the interval from the last scan that finished, since the journal holds fdrive's
   changes from the indexer's position; it scans at start only when no scan of the root has
   finished, the index has no file rows (a first start, a cleared index, a restore) or the
   indexer has no position in the journal. Changes made outside fdrive while the indexer was
   down wait for the next scan. It journals what it finds with source `scan`: new and changed
   files, files it sweeps as vanished, and folder rows it adds or drops. It does so only
   against a baseline: file rows when the root had `idx.files` rows and an earlier scan of it
   finished, folder rows when `idx.folders` had rows too. The first scan of an empty index, the scan after the
   whole index was cleared and the scan after an interrupted first scan journal nothing,
   since every file would look new. A scan after clearing part of the index journals the
   cleared files as new.

None of the three runs on a root without this installation's `.fdrive-files` marker
(`files_marker.rs`): the API writes it at the top of the files folder holding
`app.backup_configuration.installation_id`, and the indexer only reads it. While the marker is
missing, empty or names another installation, the root loop neither scans nor watches, the
watcher's deletes and renames are ignored, and the journal's reader keeps its position, so a
wrong or empty mount is never read as every file deleted. The verdict is reused for two seconds,
logged once when it changes, and kept through a database outage; a scan that came due runs as
soon as the marker is right. The marker itself is never indexed.

### Stamps

A row's `inode` and `ctime_ns` stamp its sha256: the inode and change time of the file whose
bytes the digest describes. Every write, rename or replacement moves one of the two on, and no
client can set either, so while a fresh stat still shows the stamp (and the row's size and
`mtime_ns`) the digest describes the bytes on disk. The desktop `versions` check relies on that
([MACOS.md](MACOS.md#metadata-versions-and-limits)). `indexed_at` cannot stand in for it: text
extraction sets it after the hash, and re-extracting an unchanged file sets it again without
reading the bytes. A row is stamped in three ways:

- **The indexer's own read.** It stamps the row only when it began at least a second
  (`STAMP_SETTLE`) after the file last changed and the file kept that inode and change time
  until it ended, since a write within the same tick of the filesystem's clock as the one
  before it leaves the change time unchanged.
- **An upload's hint.** The API hashed the bytes as it wrote them and stats the file right
  after publishing it, giving no hint unless it is still the inode, size and modification
  time it wrote. While a fresh stat shows exactly that size, modification time, inode and
  change time, the hint stamps the row and the file is not read at all; anything else gets
  no stamp from it.
- **A rename by fdrive.** A rename moves the change time on and keeps the bytes. The API
  stats the file right before and right after its rename. When the row's stamp is the file
  as it was right before, and a fresh stat shows it exactly as the rename left it, all four
  fields, nothing but the rename touched it, and the stamp follows it to that change time. A
  file written before the rename or after it, even with its size and time put back, shows
  another change time and keeps the old stamp, which no longer matches it.

A write by someone else that lands between fdrive's own publish or rename and the stat it
takes right after, and puts the size and modification time back, would go unseen by a hint or
a carried stamp, as would one within the same tick of the filesystem's clock; any other write
moves the change time on.

A digest reused for an unchanged file keeps the row's stamp; a new digest replaces it with its
own, or with none when it came from a read too fresh to stamp. A watcher or journaled look at
an unchanged file whose stamp no longer matches, or that has none, takes the digest from a
hint the file still matches, or else reads the file again once it has settled. The same digest stamps the row; another one is a change that kept
the size and modification time, and the file is indexed again. So the watcher's look two
seconds after an upload or rename by fdrive finds the row current and reads nothing; a file
fdrive copies or publishes from `.fdrive-desktop`, which comes with no hint and no stamped row,
is read by the journal's immediate look, too fresh to stamp, and again by the watcher's.
A rename made outside fdrive only moves the row, so that file goes unstamped until its next
change. Scans never re-read unchanged files: rows indexed before stamps existed get theirs
from a reindex or their next change. Where the API and the indexer see different inode
numbers, a stamp never matches and every check hashes.

Watcher and journaled files are foreground work: while any is pending, scan workers wait
before starting their next file, for at most a minute at a time, so a change someone just
made is not queued behind a library-wide scan.

A file is processed in the order a person notices it: its row (a name search finds it),
its thumbnails, its "indexed" signal and journal row, its text and last its embeddings. For watcher and
journaled changes, text embeddings go to a `text-embed-<root>` thread, as image embeddings do: the
chunks are stored without vectors as `partial`, searchable by full text at once, and the
worker moves on instead of waiting for the model. The thread fills in the vectors and marks
the row `indexed`, skipping a row a newer version has replaced; when its queue is full, the
worker embeds inline. Scans embed inline.

## The root

The files folder is the index's only root: `idx.roots` row 1, named `files`, which a migration
seeds, so it exists before the indexer or the API first touches the index. The indexer reads the
folder at `/data`; every `idx.files` / `idx.chunks` / `idx.folders` / `idx.scans` /
`idx.changes` / `idx.change_cursors` row carries its `root_id`. The folder needs this
installation's `.fdrive-files` marker (above).

## Settings (read from `app.settings` at the start of every scan cycle)

| Key | Type | Falls back to |
| --- | --- | --- |
| `indexer.scan_interval_seconds` | integer | `SCAN_INTERVAL_SECONDS` env (default 3600) |
| `indexer.workers` | integer, 1 to 16 (either source; each worker holds a database connection) | `INDEX_WORKERS` env (default 4) |
| `indexer.text_exclude_globs` | list of strings, matched with `fnmatch` against `<root>/<rel path>` | `TEXT_EXCLUDE_GLOBS` env |
| `indexer.ocr_image_globs` | list of strings, same matching | `["**"]`; applies only when search OCR is enabled |
| `indexer.tesseract_langs` | string, e.g. `"eng"` or `"swe+eng"` | `TESSERACT_LANGS` env |

A value change is logged (`settings changed: workers, tesseract_langs`) so an
admin editing these from the web UI's System pages can see it take effect on
the next cycle.

## The indexed signal

After every applied change that touched index rows (a file indexed as new or changed, rows
deleted or moved), the indexer sends `NOTIFY idx_events, 'files'` (its root's name), naming
nothing else. A new or changed file's signal follows its row and thumbnails, before its text. The API passes
it on to every open browser as an `indexed` event, at most once a second, so what the index
backs (folder sizes) refreshes; listings come from disk and refresh with the change journal's
own events. What changed is in the journal, which the API reads for live updates and metadata
(see [the API's reader](#the-apis-reader) below); the signal is not stored.

A reindex request or feature change that re-derives index data for a file whose size and mtime
are unchanged is not a change and sends nothing.

A scan deletes the rows its completed walk did not find, and their chunks with them. It
compares the walk with the rows it read at the start and deletes the difference in batches,
so a tree with no deletions writes nothing. Rows the watcher or a worker wrote after the scan
started are left alone. Removed files leave no row behind: the index holds what is on disk.

## The API's reader

The API reads the journal from its own position (consumer `api` in `idx.change_cursors`,
starting at the journal's end the first time) and is the only route by which it learns of file
changes ([journal.ts](../apps/api/src/events/journal.ts)). `NOTIFY idx_changes`, which every
writer sends on append, wakes it, and so does each reconnect of its `LISTEN` connection, which
reads what it missed; it does not poll. For each row it maps both ends through every login's
scopes (the home plus folders shared with it, one grants query per login per read, no storage
read) and sends each login that sees an end one live update with the row's position. A row the
API wrote brings nothing else: the file operation that made the change moved what grants
access in its own transaction and the rest right after it
([file operations](../apps/api/src/files/operations.ts)). A row from the watcher, a scan or OCR first brings path-keyed metadata and personal activity along for
each login that sees it ([outside.ts](../apps/api/src/events/outside.ts)):

- a move both ends of which a login sees moves its tags, favorites, folder views, recents and
  chat references, and a move out of what it sees drops them;
- a row that says to look again looks: a path that is gone (its folder still lists) drops them
  too, and one still there is compared with personal activity's last confirmation;
- shares with people, public links and Office files keep the owner's paths for everyone, so they
  follow once, first, in the pass for the login whose home the row's path is in.

Browsers get these on `GET /api/v1/events` ([routes.ts](../apps/api/src/events/routes.ts)).
Each `fs` event, and each ping, carries `id: <epoch>.<position>` (the journal's epoch from
`idx.change_epoch`). The web client reconnects with the last id it saw (`Last-Event-ID`, or the
`lastEventId` query parameter when it reconnects itself) and first gets the rows it missed,
mapped through its login's scopes now; when they are gone (pruned, another epoch after a
restore, or unreadable) it gets one `resync` and refetches every query on screen
([sse.ts](../apps/web/src/lib/api/sse.ts)).

Since every change fdrive makes is journaled by the API itself, live updates reach everyone
with indexing off too. Changes made on the disk reach the journal only through the watcher and
scans, which run while indexing is on.

## Internal HTTP API

Bound to `0.0.0.0:${INDEXER_PORT}` (default 8010). Not authenticated: it is
reachable only from other containers on the compose network, never exposed on
a published port in the non-dev compose file.

| Endpoint | Method | Body | Returns |
| --- | --- | --- | --- |
| `/health` | GET | None | `{ ok, watcher, embed_ok, features, storage }`: `watcher` says whether the file watcher runs, `storage` is `{ readable, writable }` for the files folder. Answers 500 while postgres is unreachable, which is what the container healthcheck keys on; the handler's connection reopens itself on the next probe once postgres is back, so a recreated `db` container never needs an indexer restart. |
| `/activity` | GET | None | In-memory scan, watcher and maintenance operations; see [System activity](SYSTEM-ACTIVITY.md). No storage scans. |
| `/stats` | GET | None | File counts by `text_status` (`counts_by_status`), chunk and embedded-chunk counts, the last scan's summary (`last_scan`), queue depth, total thumbnails, total image embeddings, a sample of recent errors, and `thumbnail_rebuild` / `image_embedding_rebuild`: `{ running, processed, total, total_known, started_at, finished_at, errors, outcome }` for the most recent rebuild pass of each kind (all zero/`null`/`false` if none has run yet). |
| `/extract-content?name=` | POST | The file's bytes, at most 4 MiB | `{ text, status }`: live text extraction of bytes the API already read through the caller's own storage, for MCP's `read_file_text` (not persisted). `name` gives the format; it is never a path. The bytes go to a temporary file removed afterwards; two run at once and a third is `429`. |
| `/reindex` | POST | `{ path?, thumbnails? }` | Marks matching rows `pending` (everything if `path` is omitted, otherwise that path and everything under it) and wakes the scan, which re-extracts text and re-embeds. Returns `{ count }`. With `thumbnails: true`, also starts a thumbnail-rebuild pass (see below) over the same scope; if one is already running, this is a no-op (best effort, not reported back). |
| `/thumbnails/rebuild` | POST | `{ path?, force? }` | Starts a background thumbnail-only pass: regenerates both sizes for every media file in scope, writing only `app.thumbnails` (`idx.files.text_status`, chunks, and embeddings are never touched, unlike `/reindex`). Without `force`, an existing thumbnail for a given sha256 and size is left alone; with `force`, it is deleted and rewritten. `path` omitted targets the whole files folder. Returns `202 { started: true, total }` (`total` is `null` until discovery completes in the background; poll `/stats` or `/activity` for the count), or `409` if a rebuild is already running (only one runs at a time, process-wide). |
| `/image-embeddings/rebuild` | POST | `{ path?, force? }` | Starts a background image-embedding backfill/rebuild pass over images in scope; see "Image embeddings" above for the `force` semantics. Returns `202 { started: true, total: null }` before discovery; `/stats` and `/activity` expose the discovered total, or `409` if a rebuild is already running. |
| `/image-embeddings/clear` | POST | `{}` or empty | Deletes every row of `app.image_embeddings`; see "Clearing derived data" below. |
| `/names/search` | POST | `{ query, scopes: [{ root_id, prefix }], exclude?, exclude_names?, files?, folders? }` | Files and folders whose name answers `query` with typos allowed (see "Name index"), at or below a scope's root-relative `prefix` (`""` for the whole root), outside every `exclude` place and with no folder in their path named one of `exclude_names` (in any case): `{ files, folders }`, each at most the count asked for (up to 200), as `{ id, root_id, path, mtime_ns }` with `mtime_ns` a string. Only the first 8 words of the first 512 characters are matched (the API checks every word again), and more than 64 scopes, exclusions or excluded names is a `400`. `503` until the index is built, so the API searches without it. |

## Image embeddings

The image unit of [`services/ml`](../services/ml/README.md) turns images and search queries
into SigLIP 2 vectors. Its activation is managed through persisted feature settings. See that
README for the model and bounded HTTP contract: 1024-dimensional, L2-normalized vectors; image
records are keyed by content sha256.

The server itself has no database access and does no indexing: it only
embeds bytes or text it is handed and normalizes the result. The indexer
reads it the same way it reads the text embedding and extraction units:
after a thumbnail is written for a file, it POSTs the 256 px WebP to
`<ML_URL>/image/embed/image` and upserts the returned vector under the
file's sha256 in `app.image_embeddings`. While the unit is unreachable,
nothing errors and nothing blocks indexing.

The `services/ml` README documents the HTTP contract (`/image/health`,
`/image/embed/image`, `/image/embed/text`), config, and testing approach in
full; it is not repeated here.

## Compose

Production starts the processing services with the core stack. Enable
processing through onboarding or System > Features:

```sh
docker compose up -d
```

Environment (see `deploy/.env.example`):

- `FDRIVE_FILES_DIR`: the host folder fdrive serves, one subfolder per user.
  It is mounted at `/data` read-write into the api (`FDRIVE_STORAGE_ROOT`) and
  OCR, and read-only into the indexer. Every login's home `<username>` is mapped
  from it; see [scoping](SCOPING.md).

Only `deploy/compose.dev.yaml` uses `--profile index`; it mounts the folder
the dev api serves (`deploy/dev/files`, read-only) at the same `/data` root
production uses, so the indexer sees exactly what the dev users see. Two things differ from the production-shaped compose file because the
api there runs on the host with `tsx watch` instead of in the compose
network: `ml` publishes its port on the host (58012 by default, override
with `FDRIVE_DEV_ML_PORT`) so `FDRIVE_ML_URL` in `apps/api/.env.dev` can
reach its units directly,
and `THUMBS_DIR` is bind-mounted to a host directory
(`deploy/dev/.data/thumbs` by default, override with
`FDRIVE_DEV_THUMBS_DIR`) rather than a named volume, so the host api process
can read the generated WebP files at the path `FDRIVE_THUMBS_DIR` names.
The dev `ml` service is built from `services/ml` on first start, which
takes several minutes, and downloads its models (about 3.1 GB) into a named
volume the first time a unit loads.

## Testing

```sh
cd services/indexer
cargo fmt --all --check
cargo clippy --all-targets --locked -- -D warnings
cargo llvm-cov --locked --fail-under-lines 95 --ignore-filename-regex 'src/main\.rs'
```

Pure modules (`paths`, `chunking`, `rules`, `events`, `thumbs`, `settings`, `features`,
`backoff`, `activity`, `jobs`) carry unit tests. Everything that touches the database runs in
`tests/` against a real Postgres started with `testcontainers`: the repository's
`packages/db/drizzle/*.sql` migrations are applied once to a template database, and each test
clones a fresh database from it. A fake `ml` server stands in for embeddings and document
extraction. Images, PDFs and videos are generated at test time; the CMYK and lossless JPEGs
in `tests/fixtures` are the only binary fixtures. Set `FDRIVE_TEST_DATABASE_URL` to use an
existing Postgres instead of Docker.

The watcher uses inotify and only works on Linux; on macOS it compiles to a stub that
reports it is unavailable. To run the whole suite, including the watcher tests, from a
non-Linux machine:

```sh
services/indexer/scripts/test-in-docker.sh
```

It runs `cargo test` in a `rust` container with the host's Docker socket, so
`testcontainers` can start Postgres. CI runs the same checks natively on `ubuntu-latest` in
the `Indexer` workflow. OCR tests skip themselves where `tesseract` is not installed, and video
tests where `ffmpeg` is not.

## Clearing derived data

Internal `POST /index/clear` accepts an empty body or `{}` for the whole index,
or `{ "path": "alice/documents" }` for one file or directory subtree; `/` selects
everything. Empty paths, traversal, malformed bodies and unknown fields are
rejected. Directory matching
uses a literal boundary, so `%` and `_` in names are never wildcards.

The background pass deletes selected `idx.files` rows and their cascading chunks
and embeddings. Original files, roots, scan history, tags, favorites,
recents, and thumbnail cache remain. It uses bounded batches and shares each
path's lock with extraction and embedding retries. It does not request a scan;
scheduled scans and later watcher changes can repopulate the index.

Internal `POST /thumbnails/clear` accepts only an empty body or `{}`. It clears
the shared preview cache and manifest, including orphan previews in the generated
SHA-256 layout. Directory descriptors and no-follow opens prevent symlink
traversal. Failed removals retain their manifest rows for retry; missing files
allow manifest cleanup. Originals and index/text/metadata rows remain. Normal
indexing or on-demand preview generation can repopulate the cache.

Internal `POST /image-embeddings/clear` also accepts only an empty body or
`{}`. It deletes every row of `app.image_embeddings` in keyset-paginated
batches; there is no cache file to remove, since the table only ever holds
vectors, never bytes. Original files, thumbnails, and index/text/metadata
rows remain. Normal indexing (with image search on) or
`/image-embeddings/rebuild` can repopulate it.

All three clear routes return `202 { "started": true }` without waiting for
discovery or deletion to finish.
Clear passes and explicit rebuilds (thumbnail and image-embedding) share
admission; conflicting requests return 409. `/stats` exposes `index_clear`,
`thumbnail_clear`, and `image_embedding_clear` records with `running`,
`processed`, `total`, `started_at`, `finished_at`, and `errors`. Totals
grow as batches are discovered. Top-level failures are counted, and admission is
released even if thread startup fails. Each background thread gets its own
thread-local database connection. These actions do not pause normal indexing.

`IMAGE_EMBED_REQUEST_BATCH_SIZE` controls how many thumbnails the indexer sends per
HTTP request (default 8); its former `IMAGE_EMBED_BATCH_SIZE` name remains a fallback
alias. The `ml` service embeds the images of a request one at a time, whatever
the request size.
