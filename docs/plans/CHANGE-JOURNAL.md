# Change journal

Started 2026-11-14. fdrive owns every write to the files folder, so one durable, numbered record
of file changes can replace the separate ways each part of fdrive finds them today. Builds on
[how changes arrive](../INDEXER.md#how-changes-arrive) and [local storage](LOCAL-STORAGE.md).

## Outcome

Every change to an indexed root is one row in `idx.changes`, numbered by its position. Every
part of fdrive that reacts to changes reads the journal from its own position, instead of each
finding changes on its own. Before this work one change could land in `app.activity_events`,
`idx.work` (a queue the indexer emptied), `idx.events` (written by the indexer, never read
back), `idx.moves` and `app.desktop_effects`; the web heard about each change twice, the Mac
app re-read folders to find changes and OCR walked the folder every night.

The journal says where to look again, not what the file now is: a consumer reads the disk or
the index for that. That keeps rows small and lets a consumer that falls behind resync from
what is there now.

## Done: the foundation

The first step replaced `idx.work` with the journal and made the indexer its first consumer.

### Schema

Migration `0024_change_journal` drops `idx.work` and adds two tables
([schema](../../packages/db/src/schema/idx.ts)).

`idx.changes`, append-only:

| Column | Meaning |
| --- | --- |
| `id` (`bigserial`) | The position, one sequence for every root. Rows are read in this order. |
| `root_id` | The index root, cascading with it. |
| `path` | Root-relative, `/`-separated, no leading slash (`alice/docs/a.pdf`), as `idx.files.path`. |
| `target_path` | Set for a move: `path` moved to `target_path`. Without it: look at `path` again (a file, a folder, or nothing any more). |
| `source` | `api`, `watcher`, `scan` or `ocr`, checked by a constraint. |
| `sha256`, `size`, `mtime_ns`, `inode`, `ctime_ns` | An upload's content hint, as `idx.work` had it: the API's digest and the file it published. Only `api` rows carry one. |
| `created_at` | When the writing transaction started. Pruning uses it. |

Indexes: `(root_id, id)` for reading a root from a position, `(created_at)` for pruning.

`idx.change_cursors`: one row per consumer and root, `(root_id, consumer)` as its key,
`position` (the last row it handled) and `updated_at`. The indexer's consumer name is
`indexer`.

`idx.change_epoch` (migration `0025_change_epoch`, added with step b): one row holding a random
`epoch`, created the first time a reader asks (`createChangeJournal().epoch()`). A reader that
hands positions to clients outside the database qualifies them with it, since positions start
again at 1 after a restore.

### Writers

- **Ordered commits.** A writer appends in one transaction that first takes
  `pg_advisory_xact_lock(hashtextextended('idx.changes', 0))`, then inserts, then sends
  `pg_notify('idx_changes', <root name>)`, which Postgres delivers on commit. The lock makes
  rows commit in position order, so a reader that sees position N sees every row below N, and
  reading `id > position` never skips a row that committed late. Every writer must take it:
  [`createChangeJournal`](../../packages/db/src/repos/changes.ts) in TypeScript and
  `db::append_changes` in the indexer do.
- **Never fail the caller.** A row is a hint; losing one costs freshness until the watcher or
  the next scan. The API logs a failed write and carries on.
- **The API** (`source = 'api'`) writes where it wrote `idx.work`: local storage reports each
  change once it succeeds, and the [change queue](../../apps/api/src/local/change-queue.ts)
  writes a tick's changes per root, at most 1,000 rows per transaction, one write after
  another. It writes nothing for a root the indexer has not created yet.
- **The indexer** (`watcher`, `scan`) appends a row for each change made outside fdrive that it
  applied, once the index has it: a file it indexed as new or changed, a path whose rows it
  deleted, a move the watcher paired, and a folder row it added or dropped. Rows go in under
  the source of the thread applying them (`journal::with_source`); the journal's own reader,
  maintenance and retries run without one and write nothing.
- **A scan journals only against a baseline.** It writes file rows only when the root already
  had `idx.files` rows and an earlier scan of it finished, and folder rows only when
  `idx.folders` had rows too. The first scan of an empty index, a scan after clearing the whole
  index and the scan after an interrupted first scan write nothing: with nothing to compare,
  every file would look new, and none of them changed. A scan after clearing part of the index
  does write the cleared files as new.
- **OCR** (`source = 'ocr'`) writes a row with no content hint after it replaces a PDF with
  its searchable version or puts a kept original back (`journal_change` in
  `services/ocr/src/fdrive_ocr/db.py`), with the same lock and notification. A failure is
  logged and never fails the file or the restore.

### The indexer as a consumer

- **Start at the end.** With no cursor, the indexer starts at the journal's newest position;
  its startup scan covers everything before.
- **Apply in order, then save.** It reads its root's rows after its position, 500 at a time,
  applies them exactly as it applied `idx.work` rows (hints, foreground priority, the worker
  pool, moves and deletes waiting for the files before them), and saves its position after each
  applied batch. A restart re-applies at most one batch; applying is idempotent because what is
  on disk when a row is applied decides.
- **Wake.** `LISTEN idx_changes`, and a look every 30 seconds without it.
- **Skip its own rows.** It passes over `watcher` and `scan` rows. It wrote each one after
  applying that change, so the index already has it. Applying them again would do nothing
  (what is on disk decides) but would cost a stat per file and a walk per folder, and a scan
  after downtime can write thousands. Skipping by source also makes "no loop" a rule rather
  than a property of the apply.
- **Wait for the marker.** While the files folder lacks this installation's `.fdrive-files`
  marker the position does not move, as `idx.work` rows waited.
- **Indexing off.** The position moves past rows without applying them; turning indexing on
  starts a scan.

### Retention and gaps

- **30 days.** The API's writer drops rows older than 30 days (`CHANGES_RETENTION`) before it
  appends. A month covers a Mac that was off for a holiday and a server-side consumer that was
  down for a long while; rows are about 150 bytes, so even a busy month of large imports stays in
  the tens of megabytes; and past it a consumer resyncs, which it must be able to do anyway.
- **Pruning is a prefix and keeps the newest row.** Pruning deletes every row at or below the
  newest one older than the cutoff, but never the newest row of the journal. So once anything
  was written, the oldest row tells what is gone.
- **Gap.** A consumer at position P has missed rows when `P < oldest - 1`, where `oldest` is the
  journal's oldest position over all roots. The test can report a gap that is not there (the
  missing positions were another root's, or rolled back) but never misses one. TypeScript's
  `read` returns it as `gap`, looking up `oldest` after the rows so a prune between the two
  cannot hide one, and reads one root or several in one statement; the indexer checks it
  before each batch.
- **Resync.** A consumer with a gap rebuilds from the current state and continues from the
  newest position. The indexer requests a scan of the root and moves its position to the end.

### Backups

All three tables are `transient` in [the backup registry](../../packages/backup/src/registry.ts). A
restore rebuilds the index from the disk (`idx.files`, `idx.chunks` and `idx.folders` are
rebuildable and the indexer scans at startup), so no consumer could resume from a position
taken before it; and a month of rows would grow every backup for nothing. After a restore the
journal starts again at position 1 under a new epoch, and the indexer at its end.

## Rules for every consumer

- Read your root's rows with `id > position`, in order; save the position after acting on them.
- Treat a row as "look here again": act on what is there now. The same change can appear twice,
  once from the API and once from the watcher, when the watcher applies a change before the
  indexer reads the API's row. Duplicates must be harmless.
- Check for a gap on every read and resync when there is one.
- Start a new consumer at the newest position; what came before is in the current state.

## Remaining steps

Proposals until built. Each step keeps the foundation's rules.

### a) The API fans changes out from the journal

Proposal: one reader in the API follows the journal (`LISTEN idx_changes`, its own cursor in
`idx.change_cursors`) and is the only route by which the API learns of file changes.

- **Resumable SSE.** Each event carries its position as the SSE `id`; a reconnecting browser
  sends `Last-Event-ID` and gets the rows after it, or a "resync" event when that is a gap. The
  web hears each change once.
- **Path-keyed metadata in one place.** Moves and deletes in the journal update tags,
  favorites, grants, the Office registry and share links in one consumer, replacing the per-route
  hooks that update them today.
- **Drop the duplicates.** Remove the API hook routes and the indexer-listener routes that
  report the same change, and `idx.events` with them. Keep a light "processed" signal from the
  indexer, so the web can show a thumbnail or search result once it is ready; it says the index
  has a file, not that the file changed.
- **Restores.** Positions restart after a restore. A browser's `Last-Event-ID` from before
  could pass for a later position; the API should qualify positions it hands out with something
  a restore changes (the journal's epoch, `idx.change_epoch`, as the Mac feed does) and answer a
  mismatch as a gap.

Done when: the web gets one event per change and resumes after a reconnect without a reload;
tags, favorites, grants, Office files and share links follow moves and deletes made over SMB as
well as in fdrive; `idx.events` and the duplicate routes are gone; tests cover a gap, a resumed
stream and a restore.

### b) A Mac change feed: done

Built on 2026-11-14: `GET /api/v2/desktop/changes?since=<anchor>`
([implementation](../../apps/api/src/desktop/changes.ts), [macOS guide](../MACOS.md#change-feed)).

- **Rows to folders.** The route reads the location's roots' rows after the anchor, 1,000 at a
  time, and maps each end of a row through the login's verified index scopes with
  `roundTripVirtualPath`, so a folder shared with the login appears under `/Shared with me`
  and a path no scope covers, or that the listings hide (Trash, `/.fdrive-desktop`), is dropped.
  Each kept end is a changed path (the app lists every browsed folder at or below it and
  validates the downloads there); its parent and grandparent are changed folders, the
  grandparent because its listing shows the parent's modification time.
- **Anchors.** `v1.<epoch>.<fingerprint>.<position>`. A different epoch (a restore), a different
  fingerprint of the location's scopes and root ids (a share added or removed, a root made
  again), a gap, an anchor past the end or none at all answers `resync` with the journal's end.
  A complete answer moves the anchor to the journal's end read before the rows, so a quiet
  location never falls into a gap.
- **Availability.** A location has a feed when its root is indexed, this API journals under it
  and the indexer has created it; its v2 `location` then says `changeFeed: true`. Otherwise the
  route answers 404 and the app keeps folder checks, as older apps do.
- **The app.** Catalog v5 stores the anchor and when every folder was last checked. A refresh
  reads every page, lists the folders named plus those not listed in full since, validates
  the downloads under changed paths, and stores the anchor only once all of that applied. On
  `resync`, without an anchor, after 50 pages, after a failed feed request, on a refresh the
  person asked for and once an hour it runs the folder checks and then stores the anchor from
  before them. Feed refreshes are paced by their own duration only, so a large location sees
  changes within about a minute.

Verified by unit tests for the mapping and the anchor, an integration test over a real files
folder and Postgres (an upload, a move and a delete through the web, a watcher row, a restore
and a gap), and Swift tests for the anchor's storage, resync and partial application. Not yet
verified: a signed app against a live server, and the hourly safety net's real cost.

Left open: changes made on the disk reach the feed only through the indexer, so names it skips,
a rewrite with the same size and modification time and anything while the marker is missing
wait for the app's hourly full check.

### c) OCR finds PDFs from the index: done

Built on 2026-11-14 ([OCR](../OCR.md#which-pdfs)). The nightly pass reads the live PDFs in
`idx.files` instead of walking the folder, leaves out fdrive's own folders and every PDF whose
`sha256` the done-log, `idx.ocr_log`, has a decision for, and checks for a text layer with
`pdftotext` before it starts `ocrmypdf`. A rewritten or restored PDF is journaled with source
`ocr`, so the indexer reads it back at once.

It does not read the journal. A row for an upload is written before the indexer has read the
file, and OCR needs the index's digest, so a journal reader would wait for the index anyway; the
nightly schedule exists to keep this CPU-heavy work at night. New PDFs wait for the next pass,
or for Run now.
