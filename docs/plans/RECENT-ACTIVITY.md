# Personal activity and file journeys

Status: shipped on `main`. The schema, repositories and migration landed in #93, the core
file, Trash, native and editor producers in #94 and #95, and the read API in #96. Everything
else, the remaining producers, Unknown observations, export and the web history and journey
UI, landed together afterwards. This document is kept as the design record; rows marked
**Since 26bc01e** record where the original `codex/recent-activity` design had to change for
main. What remains open is listed under [what is not covered](#what-is-not-covered).

## What is not covered

- No retention cutoff is enabled and no archive or purge administration exists. The plan's
  slice 4 scale qualification (a million events across accounts, measured latency budgets)
  has a PostgreSQL fixture but no production hardware promise.
- Cached and offline native opens stay unobservable, and WebDAV and S3 have no watcher: their
  Unknown events come only from refresh comparison, which the feed's coverage block states.
- Conversion and any other command that does not exist yet gets its taxonomy and inventory
  row when it ships, not before.

## Outcome and invariants

Ship useful upload completion first, then a durable personal history that answers “Where did
my upload go?” and “What happened to this file?” Web and native are the main access paths.
Unknown events explain observable gaps; they do not fabricate an external actor or destination.

- Private owner is the authenticated **account**, allowing a cross-storage timeline. Always
  retain the **storage identity** alongside it for paths, location filters, provider binding
  and share/grant checks. Every API, count, lineage edge, export and notification is owner-scoped.
- Known actions belong to their immutable actor. Unknown observations have a null actor and
  belong only to the user's already tracked personal journey. Shared-file access and admin
  status do not reveal another user's actions or create a global feed.
- History ownership never follows identity transfer. My historical facts survive inaccessible
  files, Trash and disconnected locations; live actions require current ownership/read authority.
- Stable file IDs survive proven moves/renames and accepted Trash/restore bindings. Copies and
  derived files get new IDs with lineage; deletion/recreation at one path gets a new identity.
- Record actual server outcomes, client-reported intent and uncertain observations distinctly.
  Unknown remains explicit when recovery cannot prove an outcome. Never replay file writes
  merely to repair history, or infer upload time from mtime/index discovery.
- Preserve journey metadata by default. Any configured retention/deletion is explicit and
  displays its cutoff; no silent 90-day/10,000-row truncation. Revision history does not promise
  stored old bytes, content diffs or rollback; those remain the separate snapshot feature.

## Implementer artifacts

| Artifact | Contents |
| --- | --- |
| [Event taxonomy](RECENT-ACTIVITY-EVENTS.md) | Exact action names, stages/outcomes, evidence and read-volume rules |
| [Schema and API](RECENT-ACTIVITY-SCHEMA.md) | Tables/columns, constraints, transaction boundaries, implemented endpoints |
| [Coverage inventory](RECENT-ACTIVITY-COVERAGE.md) | Existing producers, recorder seams, regressions, runtime limits and delivery slice |

The artifacts describe the implementation and its acceptance contract. Each slice has its own
definition of done below. Upload completion uses only the existing queue and navigation helpers;
it does not depend on a journal query or stable file registry.

## Source facts and explicit departures

| Area | Verified source and design consequence |
| --- | --- |
| Upload completion | [Upload store](../../apps/web/src/lib/upload/store.ts) already captures identity/target and reports success; its callback now includes the captured identity, batch and final target. [Panel](../../apps/web/src/components/activity/activity-panel.tsx) and [reveal helpers](../../apps/web/src/lib/files/reveal.ts) can provide destination/Open/Show in folder without a database change. Queue entries remain temporary in slice 1. |
| Existing Recents | [Queries](../../apps/web/src/lib/metadata/queries.ts) and `app.recents` track opened paths with no actor account. Uploads preserve original mtime, so modified-date sorting cannot substitute for upload history. |
| Identity relink | [identity-links.ts](../../packages/db/src/repos/identity-links.ts) remaps tag associations and changes the identity's account; identity-keyed favorites follow it. Recents are untouched and there is no relink history proving their original actor. Immutable activity authorship deliberately differs from current transferable metadata; keep tags/favorites behavior unchanged and do not backfill an actor from today's owner. |
| System log | [app.ts](../../packages/db/src/schema/app.ts) defines durable `system_events` for administrator/subsystem messages, with no actor. It is explicitly **not** the personal-history store; do not extend it for this feature. |
| Native journal | `desktop_operations` is recovery/receipt state, with a state/updated-time cleanup index. Current [acknowledge](../../apps/api/src/desktop/writes.ts) says receipts remain indefinitely and deletes spool data; no operation-row pruning was found in current source. History must nevertheless be independent of receipt/payload retention: copy facts into append-only events in the [complete transaction](../../packages/db/src/repos/desktop.ts), never join history to disposable recovery rows. |
| Physical/virtual bridge | Indexer payloads and `office_files` use root-relative physical locations. Consume these internally through `configuredMappings` and [roundTripVirtualPath](../../apps/api/src/scoping/round-trip.ts), honoring shadowed mounts and [scoping rules](../SCOPING.md). Persist/render virtual paths in personal events. Existing trusted registries retain their internal root/path keys; opaque registry-ID bridges are allowed. Raw physical paths never enter personal event payloads/APIs. |
| Recorder seam, **Since 26bc01e** | [Chat action tools](../../apps/api/src/ai/chat/action-tools.ts) call the exported `moveMany` and `trashMany` from [fs routes](../../apps/api/src/fs/routes.ts) directly, not over HTTP. A recorder attached to the Hono handler records nothing for an approved chat action. Record inside the shared helpers instead, and build the actor context from the principal rather than only from a request context. |
| AI producers, **Since 26bc01e** | [Organize](../../apps/api/src/ai/organize/service.ts) never moves anything itself: the web client applies its proposal through the ordinary fs routes, so F2 already covers it. [Chat](../../apps/api/src/ai/chat/actions.ts) verifies a proposal and only the person's `apply` touches storage. Both are the authenticated account acting, with `source: ai`; neither is an autonomous actor. |
| Stable registries | Office UUIDs are provider/mapped-root based; `desktop_items` is identity/path based. Bridge their IDs to tracked-file IDs without resetting native catalogs or changing Office authorization. Neither registry alone covers every producer/provider. |

### Accepted Trash binding

For SFTPGo, the configured [recycle rule](../TRASH.md) performs a synchronous rename to
`/.trash/{original directory}/{name}/{provider timestamp}`. Delete returns no new opaque
receipt to fdrive. **Full original virtual path plus the observed provider-generated timestamp
is the accepted SFTPGo binding**, scoped to storage identity/provider; do not require a UUID
that the provider cannot return. The parsed Trash entry/path becomes the restore correlation.
Capture a bounded before/after listing of that exact original-path Trash branch, associate its
new leaf with the delete, and persist the leaf verbatim. Serialize fdrive deletes of the same
path; if external concurrency yields multiple new leaves or no observable leaf, leave the
binding unresolved rather than choosing the nearest timestamp. Never fabricate the timestamp
from the API clock or correlate across folders by basename alone.

**Since 26bc01e** the WebDAV-specific destination is a shared layout, and S3 now uses it.
[withMoveToTrash](../../packages/core/src/trash/move-to-trash.ts) builds the leaf itself from
[moveTrashLeafPath](../../packages/core/src/trash/recycle-folder.ts), read back by
[createRecycleFolderTrash](../../packages/core/src/trash/recycle-folder-trash.ts) in
`layout: "move"` mode, and [storage-factory](../../apps/api/src/auth/storage-factory.ts) wraps
every provider that has no server-side rule of its own. fdrive therefore knows the exact leaf
before the move for both WebDAV and S3, so the strong binding covers both: carry that known
virtual leaf out through an internal result/hook, leaving public delete compatibility unchanged.
Restore preserves the original file ID when that accepted binding and the actual returned target
agree. Only SFTPGo keeps the weak provider-generated-timestamp case above. Trash is per storage
server, so bindings, restore and purge stay scoped to their storage identity.

## Provider-specific Unknown-event reconciliation

The SFTPGo input already exists: Linux [inotify watcher](../../services/indexer/src/fdrive_indexer/watcher.py)
→ indexer `created/changed/deleted/moved` → PostgreSQL `idx_events` →
[indexer-listener.ts](../../apps/api/src/events/indexer-listener.ts). The listener maps both
endpoints, handles unique SHA-256 metadata relinks, and checks live read authority before
announcing created/changed/moved/relinked destinations. Extend this concrete pipeline;
do not consume only the generic SSE delete after it has lost the original move evidence.

| Provider/input | Observation and required treatment |
| --- | --- |
| SFTPGo, mounted root watcher, `moved` | After round-trip mapping and pending-operation correlation, a proven in-scope move with readable destination yields `observation.location_changed`, actor unknown. Source-only mapping yields `observation.left_scope`; never include the inaccessible physical destination. A move with denied destination does not disclose the target. |
| SFTPGo watcher, `deleted` or `changed` | For an already tracked personal file, record confirmed disappearance or unexpected revision evidence after excluding known operations. An unpaired deletion cannot establish where a file went. Created events can resolve a tracked gap; they do not add everyone else's new files to My activity. |
| SFTPGo listener, SHA-256 relink | Existing behavior relinks tags/favorites for exactly one same-root/scope candidate; destination announcement requires live read. Reuse this as labelled `sha256_relink` evidence. It is a candidate for history continuity, not proof of actor or globally unique file identity. Preserve ambiguous history separately; do not weaken existing metadata behavior. Include history-tracked files when selecting candidates, not only tagged/favorited files. |
| SFTPGo, no mounted root/watcher disabled or disconnected | Fall back to authorized refresh comparison; display any observation gap. LISTEN/NOTIFY is not a durable replay log. Normal API operation history works with indexing disabled. |
| WebDAV and S3, web/native refresh comparison, **Since 26bc01e** | Neither has a watcher input. Compare complete authorized listings/stats and known registry state. Confirmed absence yields `observation.location_missing`; changed reliable version yields `observation.content_changed`. Do not claim external move/left-scope from absence alone. A verified provider ID may prove a relocation if available; path/size/hash similarity alone does not. |
| Either provider, timeout/partial scan/403 | Check/access failure only; preserve last-known state. Do not emit a move/delete observation from a failed or incomplete observation. |
| Either provider, same-path rediscovery | Append `observation.resolved` linked to the prior gap. This resolves location availability only: assign a new file UUID and target subject, keep the earlier journey unknown, and never infer identity continuity from path/size/hash. Proven watcher moves and accepted Trash receipts have their separate continuity rules. |

Unknown-event UI shows last-known location, last-confirmed time, detection time and evidence.
Example: “File no longer found at /Documents/invoice.pdf. It may have moved or been removed
outside fdrive.” Recheck is bounded to current grants. Resolve pending writes/moves/callbacks
first; deduplicate by file/prior-state/discrepancy, including across refreshes/restarts. No
outside-scope probing, guessed action time, false user attribution or repeated identical rows.

## Delivery and separate definitions of done

### Slice 1 — Upload completion, no schema

**Ships:** visible storage/destination, final filename, Open and Show in folder on successful
upload; batch completion feedback with mixed outcomes. Reveal selects/scrolls in list/grid.
Keep the page/sort unchanged. View uploads expands the current panel until history exists.

**Implementation:** extend the existing store callback to carry captured identity, final path,
local batch and result; reuse preview/reveal helpers. Keep original identity through retries
and navigation; switching login requires an explicit return to the original authorized login.
No activity schema, journal, SSE outbox, stable registry or reconciliation prerequisite.

**Done when:** old-mtime upload into a nested folder can be opened/revealed; navigation during
upload, mixed success/skip/cancel, same names on two logins and identity switching work. Inspect
320/393px and desktop, list/grid, light/dark, long names, keyboard and 44px mobile actions.
Run `application`, affected upload browser checks and real dev/provider verification, then
`workflow`. Queue history still disappears on reload: explicitly defer persistence to slice 2.

### Slice 2 — Durable personal history for core operations

**Ships:** My activity and file history for core file mutations, Trash/restore and native write
receipts, with existing Open/Show in folder. Saved records survive reload/device changes;
filter by storage/action/date and search current/historical virtual names. Recently opened
uses actor-attributed new records; ambiguous legacy Recents remain unimported.

**Implementation:** schema/recorder/outbox, stable IDs, explicit Trash binding, per-file/batch
outcomes and core/native producer rows marked S2 in the inventory. Record basic copy lineage
and revision references now; defer branch visualization/export and non-core producers.

**Done when:** upload → rename → folder move → Trash → restore stays one file history; copy
and delete/recreate have distinct IDs. Test two accounts/shared paths, relink/unlink, guessed
history IDs/cursors, native receipt independence and callback retries. Inject failure before
intent, after provider success and during outcome commit: no unjournaled begun mutation after
intent failure, no repeated file write to repair history, explicit uncertain outcome. Prove
reload/second browser with real PostgreSQL/SFTPGo/WebDAV; test 1,000 history events and a
100-file batch with bounded pagination. Run `application`, `integration`, affected `browser`,
native checks if changed, and `workflow`. UI lists currently supported history sources and its
start date; no claim of complete epic coverage yet. Unknown detection is slice 3.

### Slice 3 — Remaining producers and Unknown events

**Ships:** supported Office/MCP/read/share/metadata/archive/job actions and provider-specific
Unknown events, completing the S3 coverage rows. Drop folder-visit recording; apply the
write-time read aggregation contract, not presentation-only collapse.

**Done when:** every S3 row has its named actor/provenance/outcome regression. Exercise SFTPGo
watcher events, unique/ambiguous hash relinks, WebDAV refresh-only discrepancies, in/out-of-scope
moves, denial/outage/partial listing, duplicate observations and resolution after restart.
Prove no observer reveals others' activity or raw physical paths. Aggregate 1,000 repeated
reads with accurate counts and retry deduplication; a write splits revision groups. Confirm
native hydration/cached-open limits and Office coauthor attribution. Run affected application,
integration/browser and native/Office checks; `python indexer` if its code changes, plus
`workflow`. Full branching/export and million-event qualification remain slice 4.

### Slice 4 — Journey navigation and large-history qualification

**Ships:** copy/derived-file branches, revision/before-after details, complete actor-scoped
JSON/CSV export, explicit history boundaries and complete timeline filters/group expansion.
No retention cutoff is enabled; archive/purge administration is outside this delivery.

**Done when:** trace the full example through copies, saves, sharing, deletion/restore and
Unknown resolution; exports/counts/lineage remain private. Exercise 1,000-file batches and
one million events across multiple accounts; review query plans and measure first-page,
file-history and historical-name-search latency against budgets fixed for that fixture before
qualification. Cover the no-cutoff default, retained tombstones/lineage, no unbounded stat/hash
fan-out and accessible mobile/desktop journey UI. Run applicable full gates and real-provider
rehearsals. All inventory rows must be covered or have a documented supported-platform limit;
this is epic completion, not a gate on shipping slices 1–3.

## Product boundaries retained

**Since 26bc01e** the Mac app keeps a root-level `/.fdrive-desktop` bookkeeping folder that
[fs list](../../apps/api/src/fs/routes.ts) hides next to the trash folder. It is real on storage,
so watcher and refresh observers see its churn: exclude it at admission, exactly as the trash
folder is excluded, or the feed fills with the app's own housekeeping.

Owned shares now serve recipient traffic through fdrive's own API
([owned-access](../../apps/api/src/shares/owned-access.ts)). Not attributing a recipient's
download to the share owner is therefore a deliberate choice about observable traffic, no longer
a limitation of what fdrive can see. The shares module also holds share passwords now, which
makes the existing rule against recording secrets load-bearing rather than theoretical.

No automatic file-byte snapshots, global/admin personal feed or claims of exhaustive external
activity. A native background download is not a proven human open, and cached local opens may
be unobservable. Unsupported evidence is labelled, never invented. Routine folder navigation,
search queries, prefetch, thumbnail reads, polling and internal permission probes are excluded.
The [taxonomy](RECENT-ACTIVITY-EVENTS.md) defines the remaining explicit reads and their counts.

Implementation and verification evidence belong in the PR for each slice; the `docs/workflow`
STATUS file this plan used to reference was removed with the orchestration scripts. Server
deployment and signed native/editor release qualification remain separate.
