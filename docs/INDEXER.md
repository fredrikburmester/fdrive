# The indexer

> [!TIP]
> **Looking to configure or use search in fdrive?** See the simple user guide in **[docs/SEARCH-AND-AI.md](SEARCH-AND-AI.md)**. This document is a technical reference for developers on the Python indexing service.

`services/indexer` is a Python service that walks and watches one or more disk
roots, keeps `idx.files` / `idx.chunks` current, and generates thumbnails. It is
the direct port of filesai's `indexer.py` / `watcher.py` / `extract.py`, extended
for multiple roots, thumbnails, and change events. It never creates or migrates
its own schema: `packages/db`'s Drizzle migrations own `idx.*` and
`app.thumbnails` / `app.settings`, and the indexer waits for `idx.schema_version`
to report the version it expects before doing anything else.

See [architecture](ARCHITECTURE.md) for the service boundaries.

## What is indexed

Every regular file under a configured root, except:

- Names in `SKIP_NAMES` (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `.localized`)
  and AppleDouble sidecars (`._*`).
- Directories in `SKIP_DIRS` (`@eaDir`, `.Trash`, `.Trashes`, `node_modules`,
  `.git`).

For each file the indexer records size, mtime, a sha256, a guessed MIME type,
and (for textual extensions) extracted text, chunked and embedded. Extraction
follows filesai's rules exactly:

| Extension group | How | Notes |
| --- | --- | --- |
| `.pdf` | pymupdf, page by page | Encrypted PDFs and pages beyond `MAX_PDF_PAGES` are skipped. Under 40 characters of text counts as `no_text` (the nightly OCR job in `services/ocr` fills these in later). |
| Images (`.jpg`, `.png`, `.tif`, …) | Tesseract OCR | Only under paths matching `indexer.ocr_image_globs` (see Settings below); everything else is `excluded:image_dir`. |
| Plain text / code (`.txt`, `.md`, `.py`, …) | Read directly, multiple encodings tried | Capped at `PLAIN_TEXT_CAP` characters. |
| Office documents (`.docx`, `.xlsx`, `.pptx`, `.odt`, …) | Apache Tika | Requires the `tika` service. |
| Anything else | Not extracted | `text_status = 'none'`. |

Text is chunked 1200 characters with a 200 character overlap
(`CHUNK_CHARS` / `CHUNK_OVERLAP`), capped at `MAX_CHUNKS_PER_FILE` (400) except
spreadsheets, which cap at 40: a few dozen chunks capture the labels in a
spreadsheet without drowning search results in numeric noise. Chunks are
embedded with the `passage:` prefix against a TEI server
(`intfloat/multilingual-e5-small`, 384 dimensions, the same model filesai used,
so an imported index needs no re-embedding).

Additionally, images, the first page of PDFs, and one frame of videos (via
ffmpeg, at 1 second in) get thumbnails at 256px and 1024px on the longest side,
written as WebP under `THUMBS_DIR/<sha[:2]>/<sha>.<size>.webp` and recorded in
`app.thumbnails`, keyed by the file's sha256 so identical files never generate
the same thumbnail twice. Thumbnail failures are logged once and never fail the
file's own indexing; the image-embedding pass that follows skips a file whose
256px thumbnail was never written without logging a second error for it.

The api serves this same cache twice: `GET /api/v1/thumb` for the logged-in
file browser, and `GET /api/v1/public/shares/:id/thumb` for a public share's
gallery tiles. Both read straight from `FDRIVE_THUMBS_DIR`; neither ever goes
through SFTPGo's own file download, so loading a gallery of thumbnails never
consumes a share's download limit the way opening or downloading a full-size
image does. The public route also verifies a password-protected share's
password itself (one upstream share-root listing per password, cached for 60
seconds) before it will serve a thumbnail, since SFTPGo only checks a share's
password when it is actually asked to serve file bytes.

`POST /thumbnails/rebuild` (`thumb_rebuild.py`) is a separate, thumbnail-only
pass for when the WebP files themselves need regenerating, for example after
changing thumbnail sizes or quality, without paying the cost of a full
reindex (re-extraction and re-embedding). It walks `idx.files` rather than the
filesystem, filters down to thumbnailable extensions with the same rules as
above, and, with `force`, deletes the existing WebP files first so both sizes
are always rewritten; without `force`, existing ones are left alone and only
missing sizes are filled in. It runs in a background thread (at most one at a
time process-wide) and its progress is visible at `GET /stats` under
`thumbnail_rebuild`.

### Image embeddings (optional)

When `IMAGE_EMBED_URL` is set (the `services/image-embed` sidecar, a SigLIP 2
CLIP-style model, `google/siglip2-large-patch16-256` by default, 1024
dimensions), the indexer embeds the **256px thumbnail** it already wrote for
every image file (never the original) and stores the vector in
`app.image_embeddings`, keyed by the file's sha256 (`content_key`, the same
key `app.thumbnails` uses) so two copies of one photo are embedded once.
Absent `IMAGE_EMBED_URL`, this is entirely off: no error, `GET /stats`
reports `image_embeddings: 0`, matching how OCR degrades without its own
sidecar.

The pass hangs off the same per-file step as thumbnail generation
(`indexer.py`'s `embed_thumbnail`, called right after a thumbnail is
written): before writing anything, it checks the sidecar's `GET /health`
against the column's fixed dimension (1024) and an `"ok"` status; on a
mismatch it logs an error naming both numbers and skips embedding for that
file without writing (never truncating, padding, or otherwise coercing the
vector). A file already embedded by the currently configured model is
skipped; one embedded by a different (stale) model is always re-embedded, so
a model change self-heals as files are next touched.

`POST /image-embeddings/rebuild` (`image_embed_rebuild.py`) is the bulk
backfill/rebuild pass, mirroring `/thumbnails/rebuild`'s shape: `{ root?,
path?, force? }`, batched against the sidecar at `IMAGE_EMBED_BATCH_SIZE`
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
| `partial` | Text extracted and chunked, but embedding failed; retried on the next scan. |
| `no_text` | Extraction ran but found too little text to be useful (e.g. a scanned PDF). |
| `empty` | The file itself is empty. |
| `none` | Extension is not one the indexer knows how to extract. |
| `excluded` | Skipped by a rule: `excluded:prefix` (`indexer.text_exclude_globs`), `excluded:image_dir` (outside `indexer.ocr_image_globs`), `excluded:too_big`. |
| `error` | Extraction raised; the reason is in the row's `error` column. |

The admin **Logs** sheet on System > Indexer lists these `error` rows together with
`idx.scans` history and API-side events (settings saves, reindex and clear requests).

## Multiple roots

`INDEX_ROOTS` is a comma-separated `name=path` list, for example:

```
INDEX_ROOTS=sftpgo=/roots/sftpgo,photos=/roots/photos
```

Each name becomes a row in `idx.roots` (upserted by name on start, so restarts
reuse the same `root_id`); every `idx.files` / `idx.chunks` / `idx.scans` /
`idx.moves` / `idx.events` row carries that `root_id`. Each root gets its own
inotify watcher and its own periodic scan, running independently.

## Settings (read from `app.settings` at the start of every scan cycle)

| Key | Type | Falls back to |
| --- | --- | --- |
| `indexer.scan_interval_seconds` | integer | `SCAN_INTERVAL_SECONDS` env (default 900) |
| `indexer.workers` | integer | `INDEX_WORKERS` env (default 4) |
| `indexer.text_exclude_globs` | list of strings, matched with `fnmatch` against `<root>/<rel path>` | `TEXT_EXCLUDE_GLOBS` env |
| `indexer.ocr_image_globs` | list of strings, same matching | `["**"]`; applies only when search OCR is enabled |
| `indexer.tesseract_langs` | string, e.g. `"eng"` or `"swe+eng"` | `TESSERACT_LANGS` env |

A value change is logged (`settings changed: workers, tesseract_langs`) so an
admin editing these from the web UI's System pages can see it take effect on
the next cycle.

## Change events

After every applied change (create, change, delete, move), the indexer:

1. `INSERT`s a row into `idx.events` (`root_id`, `kind`, `path`, `target_path`).
2. `NOTIFY idx_events, '<json>'` with the same payload:
   `{ "kind": "created|changed|deleted|moved", "root": "<name>", "path": "<rel>", "target_path": "<rel or null>", "at": "<iso8601>" }`.

`idx.events` rows older than 7 days (`EVENTS_RETENTION_DAYS`) are pruned once
per scan. The API (`apps/api`) listens on `idx_events` for live updates and can
replay `idx.events` after a restart to catch anything it missed.

## Internal HTTP API

Bound to `0.0.0.0:${INDEXER_PORT}` (default 8010). Not authenticated: it is
reachable only from other containers on the compose network, never exposed on
a published port in the non-dev compose file.

| Endpoint | Method | Body | Returns |
| --- | --- | --- | --- |
| `/health` | GET | None | `{ ok, roots, watcher, embed_ok, schema_version }`. Answers 500 while postgres is unreachable, which is what the container healthcheck keys on; the handler's connection reopens itself on the next probe once postgres is back, so a recreated `db` container never needs an indexer restart. |
| `/stats` | GET | None | Per-root file counts by `text_status`, chunk and embedded-chunk counts, last scan summary, queue depth, total thumbnails, total image embeddings, a sample of recent errors, and `thumbnail_rebuild` / `image_embedding_rebuild`: `{ running, processed, total, started_at, finished_at, errors }` for the most recent rebuild pass of each kind (all zero/`null`/`false` if none has run yet). |
| `/extract` | POST | `{ root, path, offset?, max_chars? }` | Live text extraction for one file (not persisted), sliced by `offset`/`max_chars`. Used for the web app's live text preview. |
| `/reindex` | POST | `{ root, path?, thumbnails? }` | Marks matching rows `pending` (the whole root if `path` is omitted, otherwise that path and everything under it) and wakes that root's scan, which re-extracts text and re-embeds. Returns `{ count }`. With `thumbnails: true`, also starts a thumbnail-rebuild pass (see below) over the same scope; if one is already running, this is a no-op (best effort, not reported back). |
| `/thumbnails/rebuild` | POST | `{ root?, path?, force? }` | Starts a background thumbnail-only pass: regenerates both sizes for every live media file in scope, writing only `app.thumbnails` (`idx.files.text_status`, chunks, and embeddings are never touched, unlike `/reindex`). Without `force`, an existing thumbnail for a given sha256 and size is left alone; with `force`, it is deleted and rewritten. `root` omitted targets every configured root; `path` omitted targets the whole root. Returns `202 { started: true, total }` (`total` is the candidate count computed up front), or `409` if a rebuild is already running (only one runs at a time, process-wide). |
| `/image-embeddings/rebuild` | POST | `{ root?, path?, force? }` | Starts a background image-embedding backfill/rebuild pass over live images in scope; see "Image embeddings" above for the `force` semantics. Reports `image_embeddings: 0` and `total: 0` immediately when `IMAGE_EMBED_URL` is not configured, rather than discovering candidates the pass will never touch. Returns `202 { started: true, total }`, or `409` if a rebuild is already running. |
| `/image-embeddings/clear` | POST | `{}` or empty | Deletes every row of `app.image_embeddings`; see "Clearing derived data" below. |

## Image embeddings

`services/image-embed` is a separate sidecar that turns images and search queries into
SigLIP 2 vectors. Its activation is managed through persisted feature settings. See the
[service reference](../services/image-embed/README.md) for the model and bounded HTTP contract:
1024-dimensional, L2-normalized vectors; image records are keyed by content sha256.

The sidecar itself has no database access and does no indexing: it only
embeds bytes or text it is handed and normalizes the result. The indexer
reads it, when `IMAGE_EMBED_URL` is configured, the same way it reads the
text `embed` and `tika` services: after a thumbnail is written for a file,
POST the 256 px WebP to `POST /embed/image` and upsert the returned vector
under the file's sha256 in `app.image_embeddings`. As with OCR and text
embedding, an unconfigured `IMAGE_EMBED_URL` simply turns the feature off;
nothing errors and nothing blocks indexing.

`services/image-embed`'s own `README.md` documents its HTTP contract
(`/health`, `/embed/image`, `/embed/text`), config, and testing approach in
full; it is not repeated here.

## Compose

Add `--profile index` to bring up `indexer`, `tika`, `embed`, and
`image-embed` alongside the core stack:

```sh
docker compose -f compose.yaml --profile index up -d
```

Environment (see `deploy/.env.example`):

- `FDRIVE_INDEX_SFTPGO_DIR`: host directory bind-mounted read-only into the
  indexer at `/roots/sftpgo`. This must be the same directory SFTPGo itself
  serves for that root, so indexed paths line up with what users browse.
- Additional roots: copy the `indexer` service's volume line
  (`<host path>:/roots/<name>:ro`) and extend `INDEX_ROOTS` with
  `,<name>=/roots/<name>` for each one.
- SFTPGo virtual folders are only searchable when their `mapped_path` is
  under one of these roots and an administrator has mapped them per account;
  see [SFTPGo virtual folders](../deploy/REFERENCE.md#sftpgo-virtual-folders).

In `deploy/compose.dev.yaml`, the same `--profile index` mounts the dev
environment's seeded SFTPGo data (the `fdrive-dev-sftpgo-data` named volume,
read-only) so the indexer sees exactly what the `dev` user's SFTPGo account
sees. Two things differ from the production-shaped compose file because the
api there runs on the host with `tsx watch` instead of in the compose
network: `embed` publishes its port on the host (58081 by default, override
with `FDRIVE_DEV_EMBED_PORT`) so `FDRIVE_EMBED_URL` in `apps/api/.env.dev`
can reach it directly, and `THUMBS_DIR` is bind-mounted to a host directory
(`deploy/dev/.data/thumbs` by default, override with
`FDRIVE_DEV_THUMBS_DIR`) rather than a named volume, so the host api process
can read the generated WebP files at the path `FDRIVE_THUMBS_DIR` names.
`image-embed` follows the same host-published pattern (58012 by default,
override with `FDRIVE_DEV_IMAGE_EMBED_PORT`) for a future
`FDRIVE_IMAGE_EMBED_URL` in `apps/api/.env.dev`; the dev `indexer` service
already points `IMAGE_EMBED_URL` at it (`http://image-embed:8012`) so the
image embedding pass works as soon as `services/indexer` reads that
variable.

The `embed` service's image (`ghcr.io/huggingface/text-embeddings-inference`)
ships `amd64` only; on an Apple Silicon Mac, `platform: linux/amd64` in the
compose file runs it under Docker Desktop's emulation, which works but is
slower to start (the model download and warmup take roughly a minute).

## Migrating from filesai

`scripts/import-filesai.py` copies `files` and `chunks` from an old filesai
Postgres database into the new schema under one root, so nothing needs to be
re-extracted or re-embedded (the embedding model is unchanged):

```sh
python scripts/import-filesai.py \
  --source "host=old-db port=5432 dbname=filesai user=filesai password=..." \
  --target "$DATABASE_URL" \
  --root sftpgo
```

It maps `files.path` (relative to filesai's single root) straight across,
upserts the target root by name first, and carries `embedding` values over
unchanged (a `NULL` embedding stays `NULL`, so a `partial` row picks up right
where it left off on the next scan). It is idempotent: running it twice against
the same source and target is a no-op the second time, because it upserts on
`(root_id, path)`.

## Testing

Pure modules (`paths.py`, `chunking.py`, `rules.py`, `events.py`, `thumbs.py`,
`settings.py`, `stats.py`) have no I/O and are covered at 100%. I/O modules
(`db.py`, `extract.py`, `thumbs_io.py`, `indexer.py`, `thumb_rebuild.py`,
`server.py`, `main.py`) are tested against a real Postgres via
`testcontainers`, with the repo's own `packages/db/drizzle/*.sql` migrations
applied in a fixture, and a `tmp_path` directory tree (with a real small PNG
and PDF for the thumbnail tests) standing in for a root.

`watcher.py` calls `ctypes.CDLL("libc.so.6")` at import time, so it only works
on Linux; its tests are `skipif(sys.platform != "linux")`. To run the full
suite including those tests on a non-Linux machine:

```sh
services/indexer/scripts/test-in-docker.sh
```

This builds the service's own Docker image and runs pytest inside it (a real
Linux environment), using the host's Docker socket so `testcontainers` can
start its own Postgres. CI runs the same suite natively on `ubuntu-latest`,
where inotify is already available, in the `indexer` job.

## Clearing derived data

Internal `POST /index/clear` accepts an empty body or `{}` for every configured
root, or `{ "root": "sftpgo", "path": "/documents" }` for one file or directory
subtree. `path` requires `root`; `/` selects the entire root. Empty names,
traversal, malformed bodies, and unknown roots are rejected. Directory matching
uses a literal boundary, so `%` and `_` in names are never wildcards.

The background pass deletes selected `idx.files` rows and their cascading chunks
and embeddings. Original files, roots, scan/event/move history, tags, favorites,
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
rows remain. Normal indexing (with `IMAGE_EMBED_URL` configured) or
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
