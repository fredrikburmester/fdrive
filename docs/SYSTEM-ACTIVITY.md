# System sidebar activity

The admin sidebar shows a trailing spinner while a feature prepares, stops or processes
files, and while a settings action is pending. Existing navigation icons and labels remain.
Idle services are quiet. Hover or keyboard focus exposes the phase and counts; reduced
motion disables rotation. Errors, blocked retries and unavailable telemetry use a static
warning. Background job state survives navigation and reload.

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
