# System sidebar activity

Status: proposal, 2026-09-12. User requested investigation and a plan; implementation has
not started. Source reviewed on `feat/webdav-provider` at `1f045c1`, with unrelated MCP
work already present. The screenshot supplies visual context, not additional instructions.

## Intended outcome

Show a small animated spinner at the right of each System sidebar item while its work is
active. Keep the existing icon and label. Add an integer percentage when the current
operation has a trustworthy total, for example `Thumbnails   [spinner] 63%`.

Activity remains visible while navigating elsewhere and after a page reload. Idle items
keep their current appearance. Percentages describe completed work items, not elapsed time
or the fraction of the entire library successfully indexed.

## Findings from current source

| Area | Existing evidence | Limitation |
| --- | --- | --- |
| Sidebar | [AppSidebar](../../apps/web/src/components/shell/app-sidebar.tsx) renders a static admin-only System group. | No activity subscription. |
| Runtime startup/shutdown | [Feature service](../../apps/api/src/features/service.ts) exposes `preparing`, `stopping`, `ready`, `blocked`, `failed`, `off`. [Office settings](../../apps/api/src/office/settings.ts) exposes `starting`. | `ready` explicitly allows ongoing processing; startup has no percentage. |
| Thumbnail rebuild | [Rebuild worker](../../services/indexer/src/fdrive_indexer/thumb_rebuild.py) records running, processed, total, errors and timestamps. | Counts candidates before independently selecting them again for processing; concurrent changes can alter the set. |
| Image-search rebuild | [Image rebuild worker](../../services/indexer/src/fdrive_indexer/image_embed_rebuild.py) uses the same job record. | Total counts all image candidates; processed counts only attempted embeddings. Already embedded files are skipped without advancing. A direct ratio can finish below 100%. |
| Clear jobs | [Clear workers](../../services/indexer/src/fdrive_indexer/clear_jobs.py) expose the same counters. | Totals grow batch by batch, including orphan thumbnails. A ratio can repeatedly reach 100% before discovery ends. |
| Ordinary indexing | [Scan and watcher processing](../../services/indexer/src/fdrive_indexer/indexer.py) performs text extraction, text embeddings, thumbnails and image embeddings. | No live per-feature activity record. Scan history has an unfinished timestamp, but counters are finalized at the end; history can survive a crashed worker. |
| Queue and index totals | [Indexer stats](../../services/indexer/src/fdrive_indexer/server.py) counts pending manifest rows; semantic totals count existing chunks/vectors. | Queue depth omits work not yet inserted and some retries/media work. Coverage ratios do not describe a running job. |
| PDF OCR | [OCR runner](../../services/ocr/src/fdrive_ocr/runner.py) has a running lock and per-pass local counters. | Counters reach the database only at completion; no total candidate count. `seen` includes already-done files that do not appear in skipped/failed/ocred totals. |
| Polling | [System queries](../../apps/web/src/lib/api/system-queries.ts) poll detail pages every five seconds while mounted. | Mounting every detail query in the sidebar would repeatedly load manifests, count tables and walk thumbnail/original caches. |

## Recommended behavior

| Sidebar item | Activity to show |
| --- | --- |
| Features | Spinner while any feature is preparing, stopping or processing, or a feature update is pending. Tooltip lists active features; no aggregate percentage. |
| General | Spinner during its settings saves. |
| Storage | Spinner during provider tests, saves or removal. |
| Shared folders | Spinner during mapping actions. |
| Thumbnails | Automatic generation/backfill, explicit rebuild and cache clear. |
| Full-text search | Discovery/indexing, extraction (including search OCR), reindex and index clear. |
| Semantic search | Text embedding/backfill, reembed and runtime preparation. Reembed currently starts full re-extraction, so show that waiting phase too. |
| Searchable PDFs | Scheduled/manual PDF OCR passes, runtime preparation and safe stopping. |
| Image search | Automatic image embedding/backfill, explicit rebuild/clear and runtime preparation. |
| Office | Runtime startup and settings updates. Ordinary editor sessions do not currently expose a system-wide work queue. |

- Reading settings or refreshing a status query does not make an item busy. A running,
  healthy service with no work also stays idle.
- Use a quiet trailing Lucide spinner and tabular percentage digits, reserving enough room
  to avoid label movement or truncating the screenshot's longer names. Respect reduced motion.
- Hover and keyboard focus expose phase and counts, e.g. “Rebuilding previews: 630 of 1,000
  files processed; 2 errors.” Give the link an accessible activity description; avoid live
  announcements on every percentage change.
- Preparing, discovering, stopping and work without a fixed total show a spinner alone.
  Queued work remains visible; blocked retries show a static waiting/warning state rather
  than implying active computation.
- Clear the spinner when work ends. Failures/unavailable status use a small static warning
  with a tooltip; existing System pages keep detailed results. A failed feature must not
  suppress a different feature that is still processing.
- General/Storage/Shared-folder request indicators reflect this browser's pending actions.
  Service job indicators reflect server activity, including scheduled work and other admins.

## Data and implementation design

### Lightweight service activity

Add internal read-only `/activity` snapshots to the indexer and OCR service. These return
thread-safe in-memory counters and job states; no filesystem walks, manifest loads or table
scans on a status request. Reuse existing maintenance admission and progress bookkeeping.

Each operation reports a run ID, service-instance ID, feature(s), phase, running/queued state,
processed count, nullable total, unit, errors, timestamps and terminal outcome. `total: null`
means discovery is incomplete or the workload is open-ended. Include the feature revision
so configuration transitions cannot be mistaken for a completed run.

Instrument scan, watcher, media backfill, text embedding and image embedding paths. Track
queued work as well as active workers, with `finally` cleanup across failure and disable paths.
Map actual feature work: image-search internal previews can run while the public thumbnails
feature is off; do not imply that public thumbnails have been enabled. Shared discovery may
affect several enabled features, with an explicit “Discovering files” phase.

For OCR, expose current-run counters as candidates are handled, including already-done PDFs
as completed checks. Keep historical run semantics intact. Use live state for busy status,
not an unfinished historical database row.

Snapshots reset on service restart and use a new instance ID; they do not promise durable
job resumption. An unavailable source reports unknown, never successful completion.

### One admin activity query

Add typed `GET /api/v1/system/activity` contracts, route and client method. Compose the small
indexer/OCR snapshots with existing feature and Office runtime status logic. Return activity
per sidebar item and source freshness; omit settings, filenames and physical paths. Require
admin authorization before probing dependencies.

Share in-flight reads and use a short cache (about two seconds) for raw service/runtime
observations. Keep caller-specific Office/provider context outside that shared cache. Reuse
the feature service's preparation/failure rules rather than introducing a second derivation.
Timeouts or unsupported old sidecars affect only their own items. Missing telemetry means
unknown progress; do not fall back to permanent high-frequency calls to heavy `/stats`.

Mount one query inside the admin System sidebar section on every shell route. Start with
five-second polling, matching existing settings behavior; pause interval polling in hidden
tabs and refetch on focus. Stop querying and discard visible status when admin access is lost.
Pending actions update the relevant row immediately and invalidate activity when they settle.
Use mutation metadata to associate a section while preserving existing maintenance keys.

Treat a failed fetch as stale/unknown: retain last counts only with that label and stop showing
them as current progress. Reconcile local “Starting” state with fresh server job IDs so the
POST-to-poll handoff neither flickers idle nor leaves an optimistic spinner stuck after failure.

### Honest percentages

1. Use one stable candidate set for a finite rebuild's total and execution. Count each candidate
   once when resolved, including an already-complete/unsupported/skipped result. Keep success,
   skip and failure outcomes distinct. Reuse content-key deduplication consistently where used.
2. While running with a known positive total, display `min(99, floor(processed / total * 100))`.
   Only a confirmed terminal result can be 100%; an aborted run must not become “Completed.”
   Zero-work jobs return to idle without dividing by zero. Errors count as work handled, with
   an error indicator, so 100% never implies that all items succeeded.
3. Scan discovery and processing currently overlap. Keep the total unknown during discovery;
   once traversal closes, freeze the run's scheduled work count and report remaining processing
   against it. Watcher arrivals belong to separate activity, not a denominator that keeps growing.
   Semantic totals remain unknown until the relevant extraction can no longer add work.
4. PDF OCR and clears may finish discovery only near completion. Keep these indeterminate in
   the initial implementation, with live counts in the tooltip. Optional later enhancement:
   create a bounded/spooled candidate inventory first, then process it with a fixed total.
   This adds startup I/O and temporary storage and is not required merely to animate a spinner.
5. For multiple simultaneous operations, show one spinner and list them in the tooltip. Combine
   a percentage only for the same operation/unit with all totals known; weight by counts, never
   average percentages or mix files, chunks and cache entries. Otherwise omit the row percentage.

## Delivery order

1. **Prove one complete path:** indexer thumbnail activity snapshot → typed admin endpoint →
   sidebar query and indicator. Fix rebuild denominator/terminal semantics before showing its
   percentage. Verify start, visible progress, navigation/reload and completion with a real job.
2. **Cover every relevant item:** runtime transitions, image rebuild/clear, index clear, OCR,
   ordinary scans/watchers/backfills and short settings actions. Keep unknown totals
   indeterminate. Share activity state with existing maintenance summaries to avoid disagreement.
3. **Finish bounded progress and verification:** stable totals after scan discovery, image
   candidate accounting, multi-root/multi-operation behavior, stale-state handling and visual QA.
   Pre-inventorying OCR/clear work for earlier percentages remains an optional follow-up.

No application implementation, commit or deployment is authorized by this planning request.

## Acceptance and verification

- Sidebar reflects active work within one polling interval plus the short cache lifetime
  (about seven seconds); initiating actions show immediate pending feedback. Navigation/reload
  preserves visibility.
- Ready-but-idle services, disabled features with no maintenance running, status refreshes and
  non-admin accounts do not produce spinners or unauthorized activity requests. A clear of
  retained data remains visible even when the related feature is disabled.
- Exercise automatic file processing, explicit jobs, scheduled OCR, startup, stopping, retry
  backoff, errors, process restart, unavailable/older workers and simultaneous roots/features.
- Test already-embedded images, duplicate content, candidates deleted/changed mid-run, empty
  scopes, growing clear totals, aborted jobs and unknown totals. No false 100% or stuck spinner.
- Assert lightweight polling does not call manifest/cache-walk routines; concurrent requests
  share probes, and a sidebar plus an open settings page does not multiply identical probes.
- Cover accessible descriptions, keyboard tooltips, reduced motion, light/dark themes, mobile
  sidebar and the long labels shown in the screenshot.
- During implementation run focused contracts/API/web and Python tests, then required helpers:
  `application`, `integration`, `python indexer`, `python ocr`, `workflow`, and affected
  `browser` specs (`system`, `features`, `office-settings`, `system-storage`). Serialize Docker
  work. Verify the real dev app and at least one real background-processing path; intercepted
  Playwright responses alone do not establish worker behavior.
- Planning validation is limited to source inspection and documentation checks. It does not
  establish runtime performance or validate application behavior.
