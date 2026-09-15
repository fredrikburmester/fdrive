# System sidebar activity

The admin sidebar shows a trailing spinner while a feature prepares, stops or processes
files, and while a settings action is pending. Existing navigation icons and labels remain.
Idle services are quiet. Hover or keyboard focus exposes the phase and counts; reduced
motion disables rotation. Errors, blocked retries and unavailable telemetry use a static
warning. Background job state survives navigation and reload.

Features sits below Storage, with a separate expand/collapse button nesting Shared folders,
Thumbnails, Full-text search, Semantic search, Searchable PDFs, Image search and Office. The label
still opens the overview, whose activity remains visible when collapsed. General and Storage
stay at the top level. Expansion is remembered in this browser; opening a feature
page reveals its navigation item.

## Data flow

`GET /api/v1/system/activity` requires admin authorization before probing dependencies.
The response contains `observedAt` and one item per System section: state, optional percent,
detail, warning and operation IDs. It exposes no settings, paths or filenames.

The API combines the indexer/OCR `/activity` snapshots with the existing feature and Office
runtime state. Activity requests share in-flight reads and a two-second cache. Feature and
Office probes also share short caches; Office caller-specific identity data stays outside
the probe cache. No activity request calls `/stats` or walks manifests or preview caches.

One admin-only React Query polls every five seconds, pauses interval polling in hidden tabs
and refetches on focus. Failed fetches remove stale percentages and show unknown status.
Mutation metadata connects local saves/tests/jobs to their section. Accepted background
requests bridge briefly to a fresh server observation; routine status fetches do not spin.
General, Storage and Shared folders reflect this browser's pending mutations. Office reflects
startup/settings changes, not individual editor sessions.

## Worker accounting

The indexer tracks per-root scan operations, queued reindex requests, concurrent watcher work,
and explicit rebuild/clear jobs. OCR tracks both scheduled and manual passes through its
existing run lock. Snapshots are bounded, thread-safe in-memory records; reads do not query
storage. Each process has a fresh instance ID and each run has an operation ID. Counters
reset on restart; they are observations, not a durable job queue.

Operations include kind, feature IDs, revision, phase, state, processed count, nullable total,
errors, skips, unit and timestamps. Finally blocks finish failed or stopped work. Semantic
backend backoff appears as waiting. A ready runtime can still be processing files.

Normal scans currently mark every participating feature active for the entire root scan,
including discovery and the final wait for other workers. A feature's counter can therefore
pause while its spinner continues. Traversal runs ahead of processing into a backlog of up
to 20,000 classified files, so most scans leave "Discovering files" within seconds; only a
larger backlog makes traversal wait for workers. Scans embed images on a separate thread,
so Image search can trail Thumbnails while the other features finish. Counts track handled
file attempts, not newly stored thumbnails or embeddings. Each feature counts its own
stage outcome: an image embedding failure does not increment thumbnail errors. Skipped
formats and backend backoff do not count as failures. These are scan indicators, not proof
that each feature is producing output at that moment. Failed or missing derivatives can
be retried on later scans; the normal interval defaults to 15 minutes after completion.

## Persistent failure details

Thumbnails, Full-text search, Semantic search and Image search show an unresolved file
count and a **View failures** sheet. Causes, root-relative paths, attempt counts, timestamps
and operation IDs are stored in PostgreSQL (`idx.processing_failures`), independently of
worker uptime. The corresponding **Logs** sheet also includes these records. Activity
counts describe a run's attempts; the durable count describes files awaiting recovery.

Successful processing resolves a record; repeated failures update the same root/path/feature
record. Recurrence starts a new attempt count. All unresolved records remain; resolved
history is pruned after 30 days and capped at 10,000 records. Deleted files resolve their
records during pruning. Details lost before this feature was installed cannot be recovered.

Admin-only `GET /api/v1/system/processing-failures/:feature` supports `status`, `code`,
`limit` and an ID-based `before` cursor. Reads do not call workers and remain available
when a feature is off. `POST .../:feature/retry` accepts `{}` for all unresolved files or
`{"id": number}` for one. Retries share maintenance admission, preserve a fixed inventory
on temporary disk, recheck enablement, reject symlink escapes and retry only that feature.
Changed originals need text reindexing before semantic retry. Successful retries move to
resolved history; interruption or dependency waiting leaves the issue unresolved.

## Percentages

Percent means work items handled, including failures and skips; it is not elapsed time or
library coverage. Running finite work displays `min(99, floor(processed / total * 100))`.
The spinner disappears on confirmed completion. Errors remain distinguishable in details.

Thumbnail and image rebuilds use the same fixed candidate inventory for counting and
execution. Already-embedded image candidates advance progress without another embedding.
Maintenance `/stats` records now include `outcome` (`completed`, `failed`, `stopped`, or null).
An interrupted finite rebuild is never labelled completed in its settings summary.

Scan totals remain unknown during traversal, then freeze at the scheduled count while
remaining workers finish. Watcher arrivals belong to a separate open-ended operation.
Compatible simultaneous operations are weighted by their counts. Mixed kinds/units, zero
or unknown totals omit the percentage. Features overview always omits an aggregate ratio.

OCR and clear jobs show live processed counts with a spinner; their discovery has no fixed
denominator. Inventories for those jobs remain an optional enhancement, with extra startup
I/O and temporary storage. Older/unreachable sidecars report unavailable activity rather than
falling back to expensive statistics requests.
