# Indexer in Rust

Proposed 2026-11-12, not accepted. Replace the Python indexer (`services/indexer`) with a Rust
program that keeps its HTTP API, database writes, events and thumbnails, so the Python indexer
can leave the stack. Existing index rows, thumbnails and vectors stay valid: nothing is
re-indexed or re-embedded.

## Decided

- **Two binaries, two processes** (2026-11-12). The indexer ships as its own Rust binary,
  `fdrive-indexer`, next to `fdrive-ml`. The two never run in one process, so `ml` keeps having
  no database access and no mounts. Combining them into one binary with roles was rejected:
  the size it saves is small, because the large parts (ONNX Runtime, MuPDF) are not shared.
  Separate binaries keep the builds independent, so indexer changes never rebuild ONNX
  Runtime.

## Conclusions

- **Python does not leave the download.** OCR (`services/ocr`, on the `ocrmypdf` image) and the
  ONLYOFFICE controller (`deploy/office/Dockerfile.onlyoffice:3-9`, `services/runtime`) are
  Python and stay. The rewrite removes Python from the indexer image, and from the download
  only if OCR and Office are left out. If a Python-free download is the goal,
  `ocrmypdf` is the larger obstacle, not the indexer.
- **It is not expected to be faster overall.** The heavy work runs in native code: MuPDF,
  Pillow's C decoders, libwebp, tesseract and ffmpeg (the last two as child processes,
  `extract.py:60,79`, `thumbs_io.py:111-118`). Two exceptions, both to measure:
  - PDFs may get faster. PyMuPDF does not support threads (its
    [multiprocessing recipe](https://pymupdf.readthedocs.io/en/latest/recipes-multiprocessing.html)),
    yet the indexer calls it from `INDEX_WORKERS` threads (`indexer.py:971`, `extract.py:20-62`,
    `thumbs_io.py:99-108`). PDF work is effectively serialised today, and the setup is officially
    unsupported. Rust can give each worker its own MuPDF context.
  - Large camera JPEGs could get slower. Pillow decodes JPEGs at 1/2, 1/4 or 1/8 scale when that
    covers the thumbnail (`thumbs_io.py:83-87`). The `image` crate's JPEG decoder has no scaled
    decode, so a Rust version needs libjpeg-turbo (the decoder Pillow uses) to match.
- **Memory and image size should drop.** This is the main measurable gain besides packaging.
  Section 7 says how to measure it.
- **Native libraries remain.** MuPDF, libwebp, libjpeg-turbo, libheif with libde265, and dav1d
  for AVIF can all be compiled into the indexer binary statically. tesseract and ffmpeg stay separate
  programs for now, and tesseract always needs its language data files next to the binary.
- **Recommendation:** go ahead only if a Python-free indexer is a concrete next step for packaging. Build the
  Rust indexer behind a parity harness, run it in shadow against a copy of the owner's database,
  then switch the image. Do not run both indexers against the production database.
- **Size:** about 7,000 to 9,000 lines of Rust plus a similar amount of tests, in nine slices.
  Expect six to eight weeks of focused work. The parity harness and the shadow run are a
  quarter of that, and they are what makes the switch safe.

## 1. What the indexer does today

About 5,300 lines in `services/indexer/src/fdrive_indexer`. Per module:

| Module | What it does |
| --- | --- |
| `main.py` | Waits for `idx.schema_version = 1` and the `idx.processing_failures` table (`db.py:34-58`). Builds one `RootContext` per root (`INDEX_ROOTS`) and runs one loop per root: refresh settings and features every 5 s, start or stop the watcher, scan on the interval, on a wake or after a watcher overflow (`main.py:93-134`). Serves HTTP with uvicorn. |
| `config.py` | Reads every env setting and its default (`config.py:32-65`). |
| `settings.py`, `features.py` | Read `app.settings` directly: `indexer.*` keys and `features.configuration` (version 1, a revision, six booleans; anything malformed means all off, `features.py:63-78`). The indexer does not use the API's features endpoint, which `ml` polls. |
| `indexer.py` | The scan, the per-file pipeline, embedding backoff, image-embedding stage, path locks, media backfill and the watcher callbacks. |
| `watcher.py` | Raw inotify through `ctypes`: one watch per directory, 2 s debounce per path, move pairing by cookie, overflow rebuilds the watches and wakes a full scan. |
| `extract.py`, `content_extract.py` | Text extraction: PDF text layer (MuPDF), PDF OCR (render at 200 dpi, then tesseract), image OCR (tesseract), plain text (utf-16 with a BOM, utf-8, cp1252, latin-1), office documents (`PUT {TIKA_URL}/tika`, served by `ml`'s `/extract`). Embedding calls to `{EMBED_URL}/embed` with the `passage: ` prefix. |
| `chunking.py` | Normalising, extension classes and the 1,200 / 200 sliding window, capped at 400 chunks (40 for spreadsheets). |
| `thumbs.py`, `thumbs_io.py`, `raw.py`, `heif.py`, `png.py` | 256 and 1024 px WebP thumbnails for images (with HEIF, AVIF and raw), the first PDF page, and a video frame through ffmpeg. |
| `image_embed.py`, `image_embed_rebuild.py` | Embed the 256 px thumbnail with `ml`'s `/image` unit and upsert `app.image_embeddings`, plus the bulk rebuild pass. |
| `thumb_rebuild.py`, `clear_jobs.py`, `failure_retry.py` | Background maintenance passes that share one admission lock. |
| `failures.py` | `idx.processing_failures`: one row per root, path and feature, with attempts, resolution and pruning. |
| `activity.py`, `stats.py`, `server.py` | The internal HTTP API and its in-memory progress records. |
| `diagnostic_log.py` | Writes to stdout and to `INDEXER_LOG_DIR/indexer.log`, rotated at 10 MiB with four old files. Only the backup service reads that volume (`deploy/compose.yaml:159`); nothing parses the lines. |
| `scripts/import_filesai.py` | A one-off import from filesai. Nothing calls it. Not part of the rewrite. |

### Behaviour that is easy to miss

The tests pin each of these. Line numbers are in `services/indexer/src/fdrive_indexer` unless
another file is named.

**Change detection and events**
- A file counts as unchanged when size and `mtime_ns` match, the row is not `pending` and not
  deleted (`indexer.py:117-124`). Unchanged files reuse their stored sha256 when a feature
  change re-processes them (`indexer.py:314`).
- No event is emitted when a reindex or feature change re-derives data for the same version
  (`indexer.py:316-320`). Listeners check access for every event, so emitting here once flooded
  them.
- Soft deletes keep the row and its sha256. The API's delete handling reads that sha256
  (`apps/api/src/events/indexer-listener.ts:331`).

**Scans**
- A scan soft-deletes only rows that were in its starting manifest, that the walk did not see,
  and that nobody wrote after the scan started. It does this in batches of 5,000, and only after
  a complete walk (`db.py:298-329`, `indexer.py:1014-1016`).
- Traversal queues up to 20,000 classified files. At most `workers × 8` are handed to the pool,
  and dispatch waits for whichever job finishes first (`indexer.py:936-1012`).
- `PathLocks` are hierarchical: a lock on `docs` waits for `docs/a.txt` (`indexer.py:133-176`).

**Feature transitions**
- `no_text` is never retried; the retry rules per status are in `indexer.py:335-349`.
- A PDF without a text layer is `disabled:search_ocr` while OCR is off, and reading it resolves
  an earlier text failure (`indexer.py:390-392,440`). At start-up, old `no_text` PDFs are moved
  to `disabled:search_ocr` while OCR is off (`main.py:55-58`).
- A restart is not a feature transition, so it starts no media backfill (`main.py:51-53`).
- With semantic search off, chunks are stored with empty vectors and the file is `partial`
  (`indexer.py:423-427`).

**Failure handling**
- When the embedding backend is unreachable, embedding pauses for 60 s and logs one line per
  outage. Files stay `partial` with `embed:unavailable`, and the outage is not a file failure
  (`embed_backoff.py`, `indexer.py:403-422`).
- A thumbnail that failed is not retried by scans until the file changes. An unresolved failure
  stands in for the missing file (`indexer.py:630-660`, `db.py:92-107`).
- Failure records (`failures.py:73-123`): `code` is the text before the first `:` (at most 100
  characters) and `message` is at most 2,000. `attempts` restarts at 1 after a resolution. A
  skip resolves only when it read the file. Resolved records are pruned after 30 days and capped
  at 10,000.

**Thumbnails**
- The source is scaled once to the largest size needed, and the smaller size is derived from
  that. Existing sizes are left alone unless `force` (`thumbs_io.py:201-231`).
- Images are turned upright from EXIF. A JPEG over Pillow's pixel limit is decoded at a reduced
  scale (`thumbs_io.py:48-64`). PNG text chunks up to 64 MiB are allowed (`png.py`).
- Raw files use the camera's embedded preview when it covers the size. Otherwise LibRaw develops
  the image at half size, with the flip applied once (`raw.py`).
- Video frames are taken at 1 s, falling back to 0 s for short clips. "No video stream" is a
  skip that resolves earlier failures (`thumbs_io.py:121-167`).

**Image embeddings**
- The health answer is cached for 30 s. An unanswered probe keeps the last healthy answer, but
  an explicit `loading` replaces it (`indexer.py:234-254`). The dimension must be 1024
  (`image_embed.py:74-86`).
- A scan runs one embedding thread and the watcher one per root (`indexer.py:501-551`). A stale
  model is re-embedded on the live path, but a rebuild replaces it only with `force`
  (`image_embed.py:143-166`).

**Maintenance and HTTP**
- Clear, rebuild and retry passes share one admission lock, so any running pass makes the
  others answer 409 (`server.py:62-67`).
- `/extract` opens files through directory descriptors with `O_NOFOLLOW` and stays bound to the
  opened inode (`server.py:89-114`).
- The health handler's connection reopens itself after a database restart (`main.py:137-158`).

**String handling**
- Lengths, chunk cut points and the `text_chars` column count Unicode code points, not bytes
  (`chunking.py:143-162`).
- Python's `str.strip()` treats `\x1c`–`\x1f` as whitespace; Rust's `trim()` does not.
- Python's `cp1252` codec rejects five undefined bytes, while `encoding_rs` maps them
  (`extract.py:86-101`).
- `ext_of` returns `.example` for `x.env.example`, so the `.env.example` entry in `PLAIN_EXTS`
  never matches. Carry that over as is; fixing it is a separate change.

### Writes and reads

| Target | Written by | How |
| --- | --- | --- |
| `idx.roots` | start-up | Upsert by name (`db.py:72-80`) |
| `idx.files` | scan, watcher, reindex, clear, retry | Upsert to `pending`, status and error updates, soft delete, renames (deleting a stale destination row first), `mark_pending`, hard delete in clear |
| `idx.chunks` | per file | Delete and insert, set embeddings. `tsv` is a generated column and never written (`packages/db/src/schema/idx.ts:75`). |
| `idx.scans` | scan | Start and finish rows with counters |
| `idx.moves` | watcher | `actor = 'watcher'` (`indexer.py:775`) |
| `idx.events` and `NOTIFY idx_events` | per change | `{kind, root, path, target_path, at}`, compact JSON, `at` as `+00:00` ISO time. Rows older than 7 days are pruned once per scan. |
| `idx.processing_failures` | every stage | See above |
| `app.thumbnails` | thumbnails, clear | Upsert on `(content_key, size)` with `storage_path`, `width`, `height` |
| `app.image_embeddings` | image stage, rebuild, clear | Upsert on `content_key` with `model` and a 1024-wide vector |
| Reads | | `idx.schema_version`, `app.settings`; `idx.files` / `idx.chunks` / `idx.scans` for `/stats` |

## 2. Contracts that must not change

- **HTTP**, port 8010, no authentication. The API calls all 13 routes:
  - `apps/api/src/system/indexer-client.ts`: `/health`, `/stats`, `/directory`, `/reindex`,
    `/index/clear`, `/thumbnails/clear`, `/thumbnails/rebuild`, `/image-embeddings/rebuild`,
    `/image-embeddings/clear`.
  - `apps/api/src/mcp/indexer-client.ts`: `/extract` and `/extract-content`.
  - `apps/api/src/system/activity.ts:199`: `/activity`.
  - `apps/api/src/system/processing-failures.ts:40`: `/failures/retry`.

  Keep every JSON key (snake_case for `/health` and `/stats`, camelCase for `/activity`),
  every status code in `server.py` (400, 404, 408, 409, 413, 429, 503 and the 202 starts) and
  the error bodies the tests pin, such as `{"error": "path unavailable"}`. `/activity` must
  match `WorkerActivity` (`packages/contracts/src/activity.ts:18-50`), including the enums and
  ISO times with an offset. `/health` answers 500 while the database is unreachable; the
  container health check depends on that.
- **Schema.** `packages/db` migrations own `idx.*` and `app.*`. The indexer never creates or
  alters tables, and it waits for schema version 1. The rewrite needs no migration.
- **Events.** The `idx_events` channel and payload above
  (`apps/api/src/events/indexer-listener.ts:19-35`). Emit events in the same situations as
  today, not more and not fewer.
- **Thumbnails.**
  - Files: `THUMBS_DIR/<sha[:2]>/<sha>.<size>.webp` at sizes 256 and 1024 (longest side, never
    upscaled), lossy WebP at quality 82, RGB or RGBA.
  - The cache is shared with the API (read-only mount, `deploy/compose.yaml:133`). Files the
    Python indexer wrote stay valid.
  - New files will not be byte-identical to Pillow's, which is fine: nothing compares bytes.
    Image vectors computed from the new 256 px files will differ slightly; the ml README shows
    mixed vectors rank correctly.
- **Statuses and errors.** `text_status` values and the `error` column format (`excluded:*`,
  `disabled:*`, `embed:*`, `error` with `Type: message`), and the failure feature names
  `thumbnails`, `textSearch`, `semanticSearch`, `imageSearch`.
- **Scoping.** The indexer has no authorization of its own. It must keep `/directory` and
  `/extract` bounded and descriptor-relative: no symlink following below the root, the 10,000
  entry cap, and the path validation in `directory_listing.py:23-44`. The API's verification
  ([scoping](../SCOPING.md)) builds on those answers.
- **Deployment.** Same service name, the same env names (all of `config.py`, including the
  legacy `IMAGE_EMBED_BATCH_SIZE` alias), the same volumes, and `FDRIVE_RUN_AS_UID` with the
  existing `docker-entrypoint.sh`.

## 3. Libraries

Versions as on crates.io on 2026-11-12. Where `ml` already uses a crate, use the same version.

| Job | Python today | Rust choice | Native code, and how it is linked | Rejected, and why |
| --- | --- | --- | --- | --- |
| Runtime and HTTP | uvicorn, Starlette | `tokio` 1.54, `axum` 0.8.9 | None | Matches `ml`. |
| Postgres | psycopg, pgvector | `sqlx` 0.9 with runtime-checked queries, `pgvector` 0.4 | None | sqlx's compile-time macros need a database at build time or a committed generated cache. `tokio-postgres` with `deadpool-postgres` works too but needs more assembly. |
| HTTP client | httpx | `reqwest` 0.13.5 with multipart | None | Matches `ml`. |
| Hashing | hashlib | `sha2` 0.11 | None (CPU SHA instructions) | |
| Walking | `os.scandir` | `walkdir` 2.5 with sorting and a skip filter | None | `jwalk`: parallel walking is not the bottleneck and makes ordering and errors harder to follow. |
| inotify | ctypes over libc | `inotify` 0.11.5 with its tokio stream | None | `notify` 8.2: a cross-platform layer whose own rename and debounce model would have to be bent back to today's raw semantics. |
| Glob rules | `fnmatch` | `globset` 0.4.21, configured so `*` crosses `/` and backslash is not an escape | None | `wildmatch` and `glob-match`: further from fnmatch. |
| Text decoding | Python codecs | `encoding_rs` 0.8.44, plus a strict cp1252 check for the five undefined bytes | None | |
| MIME guess | `mimetypes` | `mime_guess` 2.0.5, plus the three Apple types `indexer.py:50-52` adds | None | `idx.files.mime` reaches search and MCP results (`packages/db/src/repos/index-queries.ts:102`). The parity harness lists the differences; pin a table if any matter. |
| PDF text and first page | PyMuPDF | `mupdf` 0.8.0 | MuPDF compiled from source by `mupdf-sys` and linked statically. AGPL, like fdrive. | `pdfium-render`: another engine gives different text, so different chunks, and it loads libpdfium dynamically by default. `hayro` 0.9: a pure-Rust renderer worth trying later for thumbnails, but no text extraction. `pdf-extract`/`lopdf`: weaker text. |
| OCR | pytesseract (runs the `tesseract` program) | Run the `tesseract` program with `tokio::process`, a 180 s timeout and `OMP_THREAD_LIMIT=1`, as today | Debian's tesseract, a separate process | `tesseract` 0.15 / `tesseract-rs` 0.4 in-process bindings: no timeout we control, and a crash on a hostile image would take the indexer down. Revisit if tesseract should ship inside the binary. |
| Image decoding | Pillow | `image` 0.25.10 (PNG, WebP, GIF, BMP, TIFF; EXIF orientation via `ImageDecoder::orientation`) | AVIF needs the `avif-native` feature, which builds dav1d statically | |
| JPEG decoding | Pillow (libjpeg-turbo) | `turbojpeg` 1.5.1 for JPEG sources, decoding at reduced scale like Pillow's draft mode | libjpeg-turbo built with CMake, linked statically | `zune-jpeg` (`image`'s decoder) alone has no scaled decode. Measure first: drop turbojpeg if a full decode stays within budget. |
| Resizing | Pillow bicubic with `reducing_gap=3` | `fast_image_resize` 6.1 (SIMD, Catmull-Rom is Pillow's bicubic kernel) | None | `image::imageops::resize`: several times slower. |
| WebP encoding | Pillow (libwebp), lossy q82 | `webp` 0.3.1 | libwebp built from bundled sources by `libwebp-sys`, linked statically; the same encoder Pillow uses | `image-webp`: lossless only. `zenwebp`: a young fork. |
| HEIF/HEIC | pillow-heif (libheif, libde265) | `libheif-rs` 3.0 with `libheif-sys`'s `embedded-libheif` (libheif 1.23.1) | libheif is built statically, but that feature does not bundle libde265, so the Dockerfile builds libde265 statically or uses Debian's library | `heic` 0.1.6: pure Rust but too young for hostile input. |
| Raw | rawpy (LibRaw) | `rawler` 0.8.0 (pure Rust, from dnglab): embedded previews and development | None | LibRaw bindings: `rsraw` 0.1.1 is tiny and `libraw-rs` was abandoned in 2021. Risk: camera coverage differs from LibRaw (see risks). |
| Video frame | ffmpeg and ffprobe programs | The same programs and arguments via `tokio::process`, with a 60 s timeout | Debian's ffmpeg, separate processes | `ffmpeg-next` 9.1: links libav, a large static build with licence choices. `ffmpeg-sidecar`: adds little for two fixed commands. |
| Logging | `print` and `RotatingFileHandler` | `tracing` 0.1.44 and `tracing-subscriber` 0.3.23, with `file-rotate` 0.8 for 10 MiB × 5 files | None | `tracing-appender` rotates only by time. |
| Tests | pytest, testcontainers | `testcontainers` 0.28 with the `pgvector/pgvector:pg17` image, `tempfile`, axum fakes for `ml` | | |

What this means for shipping the `fdrive-indexer` binary:
- **In the binary:** MuPDF, libwebp, libjpeg-turbo, libheif, libde265 and dav1d.
- **Next to it, for now:** tesseract plus its language data (eng and swe, a few MB each) and
  ffmpeg.
- **Later options:** tesseract could be linked in-process with leptonica (`tesseract-rs` claims
  a built-in compile), and ffmpeg through a minimal static libav with only the needed demuxers
  and decoders. Both are separate decisions with their own risks: in-process crashes, and
  codec licences.
- **Security does not change.** The indexer, which has the database and the file mounts, still
  parses hostile files in C libraries. Rust does not change that. Keep every parser behind one
  trait, so moving decoding into `ml` (no database, no mounts) or a sandboxed child process
  stays cheap later.

## 4. Where it lives, how it is built and shipped

- **Location.** A new crate `fdrive-indexer` in `services/indexer-rs/`, building the
  `fdrive-indexer` binary. When Python is removed, `git mv` it to `services/indexer`.
- **Workspace (proposed).** One Cargo workspace for both binaries from slice 1, rooted at
  `services/Cargo.toml` with one `Cargo.lock`, one toolchain pin, and the lints and
  `rustfmt.toml` `ml` uses today (`unsafe_code = "forbid"`, clippy `all = deny`). Shared crates
  (tokio, axum, reqwest, image) then stay at one version. It costs one change to `ml`'s Docker
  build context and CI cache key. The alternative is a separate workspace that copies `ml`'s
  settings by hand.
- **Module layout.** It mirrors today's split:
  - pure modules: `chunking`, `rules`, `paths`, `settings`, `features`, `events`,
    `thumbs::plan`, `image_embed::decide`, `backoff`, `activity`
  - I/O modules: `db`, `scan`, `watch` (Linux only, behind `cfg`), `extract`,
    `thumbs::render`, `jobs`, `http`
  - parsers behind a `Decoder`/`Extractor` trait
- **CI.** A new workflow `indexer-rs.yml` modelled on `ml.yml`:
  - `cargo fmt --check`, `cargo clippy -D warnings`, and
    `cargo llvm-cov --fail-under-lines 95`, excluding only `src/main.rs`. Unlike `ml`'s model
    backends, every native adapter is reachable with small fixtures, so nothing else is
    excluded.
  - The runner installs `tesseract-ocr tesseract-ocr-eng tesseract-ocr-swe ffmpeg` and
    libde265, as `services.yml` does for Python. Tests use the runner's Docker for Postgres and
    native inotify.
  - A Docker build step.
  - The Python job in `services.yml` stays until the switch.
- **Local runs on macOS.** inotify tests run in Docker, like `scripts/test-in-docker.sh` today.
- **Image.**
  - A two-stage Dockerfile like `ml`'s: build on `rust:…-trixie` pinned by digest, run on
    `debian:trixie-slim` with tesseract, its two language packs, ffmpeg, curl for the health
    check, and the same `docker-entrypoint.sh` (it is shell, not Python).
  - During the shadow run, `images.yml` publishes it as `fdrive-indexer-rs` from `main`. At the
    switch, `fdrive-indexer` is built from the Rust context and the extra entry goes away.
- **Compose.** No changes at the switch except the image contents. Rollback is the previous
  image tag, since both indexers read and write the same rows and thumbnails.

## 5. Tests

Three layers:

1. **Rust unit tests** for pure modules, job bookkeeping, backoff, health caching, path locks,
   the HTTP contract (axum's test client), and the watcher on Linux.
   - Port the Python cases table for table, with the same inputs and the same expected outputs.
   - Add non-ASCII inputs for normalising and chunking; the Python suite uses only ASCII
     there.
2. **Rust integration tests** against Postgres in testcontainers.
   - Migrations are applied the way `tests/conftest.py` does: every `packages/db/drizzle/*.sql`
     in order, split on `--> statement-breakpoint`.
   - Each test uses a temporary tree and a fake `ml` served by axum on a random port. The fake
     replaces the monkeypatching the Python suite does.
   - Fixtures are generated at test time, as today, except raw files: add a few small
     permissively licensed samples (for example DNG and CR2 from raw.pixls.us).
3. **A parity harness** (`tools/indexer-parity`, TypeScript, reusing `@fdrive/db`).
   - Setup: it starts both images against two databases built from the same migrations, with
     the same read-only fixture tree and a deterministic fake `ml`. Text vectors are derived
     from a hash of the input; image vectors from the thumbnail's pixels after downscaling to
     8×8, so small encoder differences do not show.
   - It records what each indexer sent to `ml`.
   - It drives a script of steps and compares after each step:
     - the first scan
     - create, modify, rename a file, change an extension, rename a directory, delete, and a
       move out of the root and back in
     - feature toggles for text, OCR, semantic, thumbnails and image search, on and off
     - reindex, a thumbnail rebuild with and without force, the three clears, and failure
       retries
   - Comparison:
     - Database rows are keyed by root name and path. Ids, timestamps and operation ids are left
       out, and vectors are compared within a tolerance.
     - Event kinds per path in order, `idx.moves`, and failure rows (feature, code, attempts,
       resolved or not).
     - The `/stats` and `/activity` shapes.
     - Thumbnails: the same set of files, dimensions, format and a perceptual difference under a
       threshold.
   - It runs in `CI (full)` and on pull requests that touch either indexer or the harness.

Mapping of the 29 Python test files (8,382 lines):

| Becomes | Files |
| --- | --- |
| Rust unit tests | `test_activity`, `test_config`, `test_content_extract`, `test_directory_listing`, `test_embed_backoff`, `test_events`, `test_features`, `test_image_embed`, `test_paths`, `test_settings`, `test_stats`, `test_thumbs`, `test_server`, `test_watcher` |
| Rust tests and parity cases | `test_chunking`, `test_rules`, `test_db`, `test_extract`, `test_failures`, `test_clear_jobs`, `test_indexer`, `test_main`, `test_raw`, `test_thumb_rebuild`, `test_thumbs_io`, `test_image_embed_rebuild`, `test_feature_lifecycle_regressions` |
| Dropped | `test_import_filesai` (the one-off script). Also tests of Python plumbing: the ContextVar nesting in `test_failures`, the Python logging rotation internals in the same file (keep "five files of 10 MiB" as behaviour), the injected fake watcher module in `test_indexer`, uvicorn wiring in `test_main`, and the AnyIO thread assertion in `test_server` (restate as "does not block the runtime"). |

Parity cases that need real files (the Python suite mocks some of these):
- PDF: text layer, scanned page, encrypted, mixed.
- JPEG: with EXIF orientation 6; a panorama over the pixel limit.
- PNG: with a 4 MiB text chunk; palette and RGBA images.
- HEIC and AVIF.
- Raw: DNG and CR2.
- Video: normal, shorter than 1 s, audio only, truncated.
- Text: UTF-8, UTF-16 with a BOM, cp1252 with an undefined byte, and non-ASCII text crossing a
  chunk boundary.
- A spreadsheet with more than 40 chunks (from the fake `ml`), an empty file, a FIFO and
  symlinks.
- Real tesseract on one image, to compare OCR text between the two ways of calling it.

## 6. Order of work

Every slice lands on `main` and leaves production on the Python indexer until slice 8.

| # | Slice | Done when | Size |
| --- | --- | --- | --- |
| 0 | Baseline | Section 7's numbers recorded for Python on the fixture corpus and the owner's library | S |
| 1 | Skeleton | Shared workspace with `ml`, crate, CI workflow, Dockerfile, config, logging, database connection with the schema wait, settings and features parsing, `/health`, `/stats`, empty `/activity`. Parity harness compares those three. | M |
| 2 | Text scan | Walk, hash, manifest, upsert, plain text, chunking, text embeddings with backoff, events, sweep, scan rows, failure records, path locks. Parity on text-only trees. | L |
| 3 | Documents and OCR | `ml` extraction, MuPDF text, PDF and image OCR, `/extract`, `/extract-content`, `/directory`. | M |
| 4 | Thumbnails and image search | All decoders, WebP output, image-embedding stage, health cache, media backfill on feature changes. | L |
| 5 | Watcher | inotify, debounce, rename pairing, overflow, the rename-during-indexing recheck. | M |
| 6 | Maintenance | `/reindex`, the three clears, both rebuilds, failure retry, shared admission, full `/activity`. Parity harness complete. | M |
| 7 | Shadow run | `fdrive-indexer-rs` runs on the owner's server against a copy of the database (restored from a dump into a separate database), the real root mounted read-only and its own thumbnail volume, for at least a week. A nightly comparison against production rows; every difference is fixed or accepted in writing. | M |
| 8 | Switch | `fdrive-indexer` is built from Rust; release notes; one release with the Python image tag noted for rollback. | S |
| 9 | Removal | Python indexer, its `services.yml` entry, `import_filesai.py` and its docs section deleted; `git mv` to `services/indexer`; `docs/INDEXER.md`, `ARCHITECTURE.md` and the `ml` README updated. | S |

The two indexers never run against the same database:
- Both would claim rows, double every event and fight over failure records.
- Running side by side means the parity harness and the shadow database only.

For third parties the switch is an ordinary image update; the release note says so.

## 7. What to measure

The same corpus, host and settings for both indexers, on amd64 and on arm64:

| Measure | How |
| --- | --- |
| Cold indexing throughput | Fresh database and empty thumbnail volume, all features on. Time from start to an idle `/activity`, with `ml` replaced by a fake with a fixed delay (isolates the indexer) and once with the real `ml`. Files per second by kind from `idx.files.indexed_at`. |
| CPU | cgroup `cpu.stat` `usage_usec` before and after, per run. |
| Memory | cgroup `memory.peak` during the cold run, and `memory.current` when idle after it. |
| Rescan of an unchanged tree | Time of a scan over 100,000 unchanged files (`idx.scans` started and finished). |
| Watcher latency | A file written to an `idx_events` notification, measured with a `LISTEN` client. |
| Image size | `docker image inspect --format '{{.Size}}'` and `docker history` for both images. |
| Thumbnail quality | Perceptual difference and file size against Pillow's output on the corpus. |
| PDF concurrency | Cold run on a PDF-only corpus with 1 and 4 workers, to test the PyMuPDF claim above. |

Corpus: the parity fixtures plus a fixed sample of the owner's library (photos, raw files,
PDFs, office documents, videos), mounted read-only. `tools/perf` stays for end-to-end budgets.

## 8. Risks and open questions

**Risks**
- **Behaviour drift** in rarely used paths: feature transitions, failure records, partial
  thumbnails. The parity harness and the shadow run exist for this.
- **Raw coverage.** `rawler` supports a different set of cameras than LibRaw. A file it cannot
  read records a thumbnail failure instead of a thumbnail. Check the owner's raw files during
  the shadow run before accepting.
- **Native builds.** MuPDF, libheif with libde265, dav1d and libjpeg-turbo built from source
  lengthen CI builds and need a CMake toolchain. Cache like `ml` does.
- **MuPDF threading** in the `mupdf` crate: confirm it gives each thread its own context before
  slice 3, or use a dedicated pool where each thread owns its own.
- **Text differences** change chunks only for files that are re-extracted, never for existing
  rows. The parity harness makes any difference visible.
- **Opportunity cost.** The benefit is mostly packaging; the roadmap waits meanwhile.

**Open questions**
- Is a Python-free indexer worth it, given that Python stays in the OCR and Office images?
- Should decoding of untrusted files move into `ml` later (no database, no mounts)? It would
  make the indexer pure Rust apart from tesseract and ffmpeg, at the cost of sending file bytes
  over HTTP, up to 200 MiB for videos.

**Not rewritten**
- `import_filesai.py` (delete it).
- The OCR service.
- The schema.
- The API's indexer clients.

Known oddities, such as the dead `.env.example` entry, carry over unchanged and get their own
changes afterwards.

## Completion criteria

- The Rust indexer passes its own suite at 95% line coverage and the parity harness with no
  unexplained differences.
- The shadow run's differences are fixed or accepted in writing.
- Production runs the Rust image for two weeks with no rollback.
- The Python indexer, its CI job and its docs are gone.
- Section 7's before and after numbers are recorded in `docs/INDEXER.md`.
