# The OCR service

> [!TIP]
> **Looking to configure or use OCR in fdrive?** See the simple user guide in **[docs/SEARCH-AND-AI.md](SEARCH-AND-AI.md)**. This document is a technical reference for developers on the Python OCR service.

`services/ocr` is a small Python service that runs a nightly OCR pass over one
or more disk roots, giving scanned PDFs a text layer so the indexer (and
therefore search) can find them. It is the direct port of filesai's
`ocr/run.sh`, extended for multiple roots and a Postgres-backed done-log, with
status endpoints so the web app's System page can show and trigger it. It
never creates or migrates its own schema: `packages/db`'s Drizzle migrations
own `idx.ocr_log` and `idx.ocr_runs`, and the service waits for
`idx.schema_version` to report the version it expects before doing anything.

See [architecture](ARCHITECTURE.md) for the service boundaries.

## What it does, and what it refuses to touch

Once per configured hour (and on demand via `POST /run`), the service walks
every configured root for `*.pdf` files (skipping AppleDouble sidecars like
`._report.pdf` and the same directories the indexer skips: `@eaDir`,
`.Trash`, `.Trashes`, `node_modules`, `.git`) and runs `ocrmypdf` on each one
that is not already recorded as done for its current size and mtime.

`ocrmypdf` is **never** called with `--skip-text` or `--force-ocr`. That is
the single most important safety property of this service: a PDF that already
has a text layer is left completely alone.

| `ocrmypdf` result | Recorded status | What happens to the file |
| --- | --- | --- |
| Exit 0 | `ocred` | The output replaces the original, keeping its owner, mode, and mtime. The original bytes are kept under `<state_dir>/originals` when `ocr.keep_originals` is set. |
| Exit 6, or stderr mentions `TaggedPDFError` | `has_text` | Untouched. `ocrmypdf` already found a text layer (an office-generated PDF sometimes only reports this via the error message, not the exit code). |
| stderr mentions `DigitalSignatureError` | `signed` | Untouched. Signed PDFs are refused outright: OCR would invalidate the signature. |
| stderr mentions `EncryptedPdfError` | `encrypted` | Untouched. |
| Over `ocr.max_mb`, or matched by `ocr.exclude_globs` | `too_big` / `excluded` | Untouched, never even handed to `ocrmypdf`. |
| Killed after `OCR_TIMEOUT_SECONDS` (default 900) | `timeout` | Untouched. |
| Anything else | `failed`, with the last few lines of stderr as `detail` | Untouched. |

Every outcome, including failures, is written to `idx.ocr_log` keyed on
`(root_id, path, size, mtime_ns)`. This is the done-log: the next pass skips a
file whose key is already present, so a large tree with a handful of scanned
PDFs is only ever OCR'd once, and a `failed` result is not retried on every
single pass either (only once the file itself changes). `ocrmypdf` also runs
with `--skip-big <ocr.max_mb>` as a second, page-level guard against runaway
memory use on a huge scanned page, in addition to the whole-file size cap
applied before the subprocess is even started.

## Settings (read from `app.settings` before every pass)

| Key | Type | Default |
| --- | --- | --- |
| `ocr.hour` | integer, 0..23 | `3` (falls back to the default for any out-of-range value) |
| `ocr.langs` | string, `ocrmypdf -l` value | `"swe+eng"` |
| `ocr.exclude_globs` | list of strings, matched with `fnmatch` against `<root>/<rel path>` (same convention as the indexer's `indexer.text_exclude_globs`) | `["Programs/**", "Photos/**", "Videos/**"]` |
| `ocr.max_mb` | integer | `200` |
| `ocr.keep_originals` | boolean | `true` |

**On the `exclude_globs` default.** The match key is `<root>/<rel path>`, the
same convention the indexer uses, so a bare `"Photos/**"` only excludes paths
under a root literally named `Photos`. filesai's original defaults
(`Programs`, `Photos`, `Videos`) were top-level directories under its one
`/data` root; carried over verbatim here for continuity, they only do
something useful again once you either name a root that way, or replace them
with root-qualified patterns for a per-user layout, e.g.
`"sftpgo/*/Photos/**"` to exclude every user's `Photos` folder under a root
named `sftpgo`.

A value change is logged (`settings changed: ...`) the same way the indexer
logs its own settings changes.

## Multiple roots

`INDEX_ROOTS` is the same comma-separated `name=path` format the indexer uses:

```
INDEX_ROOTS=sftpgo=/roots/sftpgo,photos=/roots/photos
```

Each name is upserted into the shared `idx.roots` table (same rows the indexer
uses), so `idx.ocr_log.root_id` lines up with `idx.files.root_id`. Every
configured root is walked in the same pass; there is one `idx.ocr_runs` row
per pass covering all of them, not one per root.

## Internal HTTP API

Bound to `0.0.0.0:${OCR_PORT}` (default 8011). Not authenticated: reachable
only from other containers on the compose network.

| Endpoint | Method | Returns |
| --- | --- | --- |
| `/health` | GET | `{ ok, running }`. `ok` is `false` until the schema handshake with `idx.schema_version` has completed. |
| `/stats` | GET | `{ last_run, next_run_at, schedule_hour, langs, exclude_globs, max_mb, keep_originals, originals_count, originals_bytes, running }`. `last_run` is `{ started_at, finished_at, seen, ocred, skipped, failed }` or `null` if no pass has ever run. `originals_count` / `originals_bytes` describe `<state_dir>/originals` on disk right now. |
| `/run` | POST | `202 { started: true }`, or `409 { error: "already running" }` if a pass (scheduled or manual) is already in progress. Runs in the background; poll `/stats` or `/health` for completion. |

`seen` in a run summary counts every candidate PDF the walk encountered,
including ones already in the done-log; `ocred` / `skipped` / `failed` only
count files actually decided on this pass (`too_big`, `excluded`, `has_text`,
`signed`, and `encrypted` all fold into `skipped`).

The admin **Logs** sheet on System > OCR reads `idx.ocr_runs` and failed or timed-out
`idx.ocr_log` rows, alongside API-side events such as settings saves and run requests.

## Compose

Add `--profile index` to bring up `ocr` alongside `indexer`, `tika`, and
`embed`:

```sh
docker compose -f compose.yaml --profile index up -d
```

`ocr` mounts the same `FDRIVE_INDEX_SFTPGO_DIR` host directory as the indexer,
but **read-write** (the indexer only needs read-only), plus its own state
directory at `${FDRIVE_DATA_DIR}/ocr` for kept originals. The api's
`FDRIVE_OCR_URL` (`http://ocr:8011`) is only reachable when this profile is
up; the api treats a connection failure as "OCR status unknown", not an
error.

In `deploy/compose.dev.yaml`, `ocr` mounts the dev stack's seeded SFTPGo data
volume read-write and starts with `OCR_RUN_ON_START=false` so bringing the
profile up does not immediately rewrite dev fixtures; trigger a pass
explicitly with `POST /run` when you want to exercise it.

## Migrating from filesai

filesai kept its done-log as a flat `$STATE/done.tsv` (`<size>_<mtime>|<path>
TAB status`). `scripts/import-done-tsv.py` imports it into `idx.ocr_log` so
the first pass here does not re-OCR everything filesai had already handled:

```sh
python scripts/import-done-tsv.py done.tsv --root sftpgo \
  --database-url "$DATABASE_URL"
```

filesai's key only has second-precision mtimes, while `idx.ocr_log` keys on
`mtime_ns`; the importer scales seconds to nanoseconds. If a file's real mtime
carries sub-second precision the imported key will not match on the first
pass, so that one file gets reprocessed once; this is safe, since OCR is idempotent
and refuses PDFs that already have text. It is otherwise idempotent: rows are
inserted `ON CONFLICT ... DO NOTHING` on the same unique key the service
itself uses, so running it twice is a no-op the second time.

## Testing

Pure modules (`schedule.py`, `decide.py`, `rules.py`, `settings.py`,
`stats.py`) have no I/O and are covered at 100%. I/O modules (`db.py`,
`runner.py`, `server.py`, `main.py`) are tested against a real Postgres via
`testcontainers`, with the repo's own `packages/db/drizzle/*.sql` migrations
applied in a fixture, and a fake `ocrmypdf` executable
(`tests/fixtures/ocrmypdf`) placed first on `PATH` by an autouse fixture in
`tests/conftest.py`. The fake reads a marker from the first line of its input
file (`OK`, `HASTEXT`, `TAGGED`, `SIGNED`, `ENCRYPTED`, `FAIL`, `HANG`) and
exits accordingly, so no test needs a real scanned PDF or the real (slow)
tool.

```sh
services/ocr/scripts/test-in-docker.sh
```

builds the service's own Docker image (the only place `ocrmypdf` and its
Swedish/English tesseract data are actually installed) and runs the same
suite inside it, using the host's Docker socket so `testcontainers` can start
its own Postgres from inside the container. CI runs the suite natively on
`ubuntu-latest` in the `ocr` job, since the fake `ocrmypdf` means the real
tool is never required to run the tests.
