# The OCR service

> [!TIP]
> **Looking to configure or use OCR in fdrive?** See the simple user guide in **[docs/SEARCH-AND-AI.md](SEARCH-AND-AI.md)**. This document is a technical reference for developers on the Python OCR service.

`services/ocr` is a small Python service that runs a nightly OCR pass over one
or more disk roots, rewriting scanned PDFs to add a permanent searchable text layer
via `ocrmypdf` for PDF readers. (Search indexing itself also extracts text in-memory
from scans and images during indexer scans when the `searchOcr` feature is enabled,
without altering original files). It is the direct port of filesai's
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
| Exit 0 | `ocred` | The output replaces the original, keeping its owner, mode, and mtime. The original bytes are kept under `<state_dir>/originals` when `ocr.keep_originals` is set, and can be put back later; see [Kept originals](#kept-originals). |
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
with `--skip-big 50` (50 megapixels per page, independent of the PDF megabyte
limit) as a page-level guard against runaway memory use on a huge scanned page,
in addition to the whole-file size cap applied before the subprocess is even started.

## Settings (read from `app.settings` before every pass)

| Key | Type | Default |
| --- | --- | --- |
| `ocr.hour` | integer, 0..23 | `3` (falls back to the default for any out-of-range value) |
| `ocr.langs` | string, `ocrmypdf -l` value | `"swe+eng"` |
| `ocr.exclude_globs` | list of strings, matched with `fnmatch` against `<root>/<rel path>` (same convention as the indexer's `indexer.text_exclude_globs`) | `["Programs/**", "Photos/**", "Videos/**"]` |
| `ocr.max_mb` | integer | `200` |
| `ocr.keep_originals` | boolean | `true` |
| `ocr.originals_retention_days` | integer, `0` keeps forever | `0` |

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
| `/activity` | GET | In-memory current/last OCR operation, including live processed/skipped/error counts; see [System activity](SYSTEM-ACTIVITY.md). No storage scans. |
| `/stats` | GET | `{ last_run, next_run_at, schedule_hour, langs, exclude_globs, max_mb, keep_originals, originals_retention_days, originals_count, originals_bytes, running }`. `last_run` is `{ started_at, finished_at, seen, ocred, skipped, failed }` or `null` if no pass has ever run. `originals_count` / `originals_bytes` describe `<state_dir>/originals` on disk right now. |
| `/run` | POST | `202 { started: true }`, or `409 { error: "already running" }` if a pass (scheduled or manual) is already in progress. Runs in the background; poll `/stats` or `/health` for completion. |
| `/originals` | GET | One page of kept originals: `{ items, total, offset, limit }`, newest first. `query` (substring of `<root>/<path>`), `offset` and `limit` (max 200) are query parameters. |
| `/originals/download` | GET | The kept bytes for `?id=`, as `application/pdf`. |
| `/originals/restore` | POST | `{ id, allow_recreate?, allow_overwrite_changed? }`. `200 { restored: true, root, path, previous_state }`, `404` for an unknown id, or `409 { error, state, root, path }` for a refusal. |
| `/originals/delete` | POST | `{ id }` -> `200 { deleted: true }` or `404`. Deletes the kept bytes and their sidecar. |

Only `/run` is gated on the `pdfOcr` feature. Everything under `/originals`
keeps working while OCR is switched off, because switching it off is exactly
what an operator does first when a pass has damaged a file they now need back.

`seen` in a run summary counts every candidate PDF the walk encountered,
including ones already in the done-log; `ocred` / `skipped` / `failed` only
count files actually decided on this pass (`too_big`, `excluded`, `has_text`,
`signed`, and `encrypted` all fold into `skipped`).

The admin **Logs** sheet on System > OCR reads `idx.ocr_runs` and failed or timed-out
`idx.ocr_log` rows, alongside API-side events such as settings saves and run requests.

## Kept originals

Every rewrite copies the pre-OCR bytes to
`<state_dir>/originals/<16 hex digits>_<basename>` and writes a sidecar next to
it at `<state_dir>/original-mappings/<that name>.json`, fsynced before the
source file can be overwritten:

```json
{"version":1,"root":"sftpgo","path":"fredrik/docs/scan.pdf","size":184320,
 "mtime_ns":"1757000000123456789","original":"0123456789abcdef_scan.pdf",
 "sha256":"...","kept_at_ns":"1757200000000000000"}
```

The kept filename embeds a truncated hash of `root:path:size:mtime_ns`, which
is not reversible; the sidecar is what makes a restore possible at all. Note
that `apply_rewrite` copies the *source's* mtime onto the kept copy, so the
kept file's own mtime is the age of the document, never the age of the copy:
`kept_at_ns` is the only honest record of when the bytes were kept, and it is
what retention and the admin UI use. Originals kept before `kept_at_ns`
existed fall back to the sidecar's own mtime, and ones kept before sidecars
existed fall back to the kept file's ctime.

### Restoring

`System > Searchable PDFs > Kept originals` in the web app lists them; the API
proxies the endpoints above under `/api/v1/system/ocr/originals`. A restore is
`apply_rewrite` run backwards and inherits its durability properties: the
replacement is staged in the destination directory, hashed while it is copied,
fsynced, given the destination's ownership and the recorded mtime, and only
then swapped in with `os.replace`, all inside the same `db.backup_checkpoint`
advisory-lock gate a rewrite takes. Bytes that no longer hash to the sidecar's
`sha256` are refused rather than written over the live file. Restore checks
the destination after acquiring its locks and rechecks its device, inode,
size, nanosecond mtime/ctime and mode immediately before replacement. A change
during the copy is refused even if the caller opted into overwriting the
previously inspected version or recreating a missing file.

OCR and restore commits also share a PostgreSQL lock per root/path. OCR runs
its subprocess outside that lock, then refreshes the done-log while holding it
before committing output. Cache misses also consult the current done-log, so
a pass that started before a restore cannot undo it. Ordinary storage writes
do not participate in this OCR lock; their concurrent edits are checked
optimistically immediately before replacement. Lock waits and restore copies
run off the HTTP event loop.

The state of the file at a kept original's source path decides what a restore
means. A rewrite keeps the source's mtime; an OCR result with another mtime
belongs to another revision and requires overwrite consent:

| State | Meaning | Restoring |
| --- | --- | --- |
| `ocred` | the live file matches an `ocred` row for that path and this original's mtime | the ordinary case, no opt-in |
| `restored` | the live bytes already match the kept original | a no-op, no opt-in |
| `changed` | the file matches neither: edited or replaced after OCR ran | needs `allow_overwrite_changed` |
| `missing` | nothing is at that path any more | needs `allow_recreate` |

A successful restore records an `idx.ocr_log` row for the *restored* file's own
`(path, size, mtime_ns)` key with status `restored`. Without it the next pass
would see a key it has never decided on and OCR the file straight back again,
which is what made the old manual "copy it back over the PDF yourself"
procedure silently undo itself. The kept copy is not deleted, so a restore can
be repeated, and the pre-rewrite row for the OCR output is left alone.

A restore is refused, never half-applied, when the sidecar cannot be resolved,
its root is not configured on this service, its recorded path does not stay
inside that root, or the directory that held the file is gone. In every one of
those cases the bytes are still downloadable, so a manual recovery remains
possible.

### Originals kept before sidecars existed

An original with no sidecar is resolved from the done-log: rows whose
`mtime_ns` and basename match the kept copy are reverse-hashed against the kept
filename, and only an unambiguous single match is accepted (the same rule
`packages/backup/src/ocr-mappings.ts` applies to archived bytes). A resolved
match is written back out as a sidecar, dated to the kept file's ctime so the
backfill does not restart the retention clock, and the lookup happens once.
Anything ambiguous stays listed as unresolved and download-only.

### Retention

`ocr.originals_retention_days` deletes kept originals older than the window at
the end of each pass. It defaults to `0`, keeping them forever, so an
installation that upgrades into this setting never loses bytes it was already
holding. `OCR_ORIGINALS_RETENTION_DAYS` sets the default for an installation
with no stored value. Individual originals can also be deleted from the admin
sheet. Both deletion paths hold the shared backup gate while removing the
bytes and sidecar, so they wait for an active backup capture to finish.

## Compose

Production starts `ocr` alongside the other bundled services. Enable Searchable
PDFs through onboarding or System > Features to allow processing:

```sh
docker compose -f compose.yaml up -d
```

`ocr` mounts the same `FDRIVE_INDEX_SFTPGO_DIR` host directory as the indexer,
but **read-write** (the indexer only needs read-only), plus its own state
directory at `${FDRIVE_DATA_DIR}/ocr` for kept originals. The api's
`FDRIVE_OCR_URL` (`http://ocr:8011`) is internal to the production network; the worker remains
reachable while disabled. A connection failure reports unknown OCR status.

Only the dev compose file uses `--profile index`. In `deploy/compose.dev.yaml`, `ocr` mounts the dev stack's seeded SFTPGo data
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
`stats.py`, `originals.py`) have no I/O and are covered at 100%. I/O modules
(`db.py`, `runner.py`, `restore.py`, `server.py`, `main.py`) are tested against a real Postgres via
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
