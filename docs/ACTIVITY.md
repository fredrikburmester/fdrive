# Personal activity

Each account has a private history of what it did to its files, and of changes fdrive noticed
to files that history already follows. It answers "Where did my upload go?" and "What happened
to this file?" The web app shows it at `/activity`, per file at `/activity/files/:fileId` and per
batch at `/activity/batches/:batchId`; Recently opened (`/recents`) reads it too. It is separate
from the actorless administrator log, `app.system_events`, which it never extends. Upload
completion in the activity panel (destination, **Open**, **Show in folder**) comes from the
upload queue and needs no history.

Source of truth: the [schema](../packages/db/src/schema/activity.ts) and its migrations, the
[contracts](../packages/contracts/src/personal-activity.ts), the
[repositories](../packages/db/src/repos/activity.ts) and the API's
[activity module](../apps/api/src/activity/).

## Rules

- The private owner is the authenticated **account**, so one timeline covers its login. Each
  event also keeps its **storage identity**, for paths and share/grant checks. Every API, count, lineage edge, export and notification is owner-scoped.
- Actions belong to their actor, who is the owner. Unknown observations have no actor and
  attach only to files the owner already tracks. Shared-file access and administrator rights
  never reveal another user's actions; there is no global feed.
- History never follows a login to another account, unlike tags and favorites. It survives
  unreadable files, Trash and disconnected locations; live actions need current ownership and
  read access.
- A file keeps its ID through proven moves and renames and through Trash and restore. Copies and
  derived files get new IDs with a lineage edge; deleting and recreating a path gives a new ID.
- Server outcomes, client-reported intent and uncertain observations stay distinct. An outcome
  recovery cannot prove stays unknown. File writes are never replayed to repair history, and
  upload time is never inferred from a modification time or from indexing.
- History has no retention cutoff. Revision history records evidence, not old bytes, diffs or
  rollback.

## Events

### Envelope

- `class`: `action | observation`. Actions require authenticated actor = owner; observations
  require a null actor and an existing journey for the owner.
- `stage`: `intent | outcome | reconciliation`. Intent has a null outcome. Observation detection
  uses the outcome stage; its later resolution uses reconciliation and links the earlier event.
- `outcome`: `success | failed | denied | cancelled | skipped | conflict | partial | unknown`.
  Outcomes describe the named operation, not whether an HTTP request returned 200.
- `source`: `web | api | ai | office | mcp | native | indexer`. `ai` marks a mutation
  the person approved in AI organize or AI chat; `detail` names which, with its run or
  conversation. The actor stays the authenticated account: the assistant proposes, the person
  applies.
- `evidence`: `server_confirmed | client_reported | watcher_move | watcher_change |
  sha256_relink | reconciled`. Evidence is structured with bounded detail; its label does not
  itself grant access.
- `schemaVersion`: `1`. The client validates this version and the enumerated actions; a future
  version needs a compatible client and contract, never reinterpretation as a successful upload.

### Actions

Mutating actions support intent and outcome; conflicts, cancellation, errors and partial bulk
results use the same action name with the matching outcome. Batch rows summarize children; they
do not replace per-file facts. No generic job-completion event duplicates an action: an archive
job completes its `archive.compress` or `archive.extract` operation.

| Action | Meaning and detail |
| --- | --- |
| `file.upload` | User-supplied upload: target, size, batch, revision evidence. Replacement flag only when the storage result proves it. |
| `file.create` | New empty, text or document file: actual destination and creation source. |
| `folder.create` | Explicit folder creation; folders an upload creates are details of that upload. |
| `file.save` | Confirmed content update: prior and new revision evidence, size, editor or source. |
| `file.rename` | New name within the parent: before and after paths, same file ID. Folders too. |
| `file.move` | Relocation: both storage identities and paths when they differ. |
| `file.copy` | Copy, Duplicate or Save As: new target ID plus a source edge; variant in details. |
| `file.trash` | Recoverable removal: the Trash binding and prior path. |
| `file.restore` | Restored item: the Trash binding, actual target, same ID when the binding holds. |
| `file.delete` | Permanent removal, a tombstone. A missing or denied request records only the attempted path. |
| `trash.empty` | Parent operation with bounded per-item `file.delete` children and exact counts. |
| `file.open` | Explicit editor or document open; not proof of a save. `recents/touch` is client-reported. |
| `file.preview` | Explicit preview gesture; separate from transport prefetch. |
| `file.inspect` | Explicit Info or inspector action; a background `stat` does not emit it. |
| `file.read` | Explicit MCP content read, including continuation requests. |
| `file.download` | Explicit download of original bytes; the outcome describes server delivery, not a save to disk. |
| `file.materialize` | Mac content download; no claim of a human open. |
| `file.reveal` | **Show in folder**; client-reported, no folder-visit cascade. |
| `archive.inspect` | Explicit archive listing or preview; internal entry probes are not separate gestures. |
| `archive.compress` | Archive job or streamed ZIP: inputs, result if stored, variant, byte and child counts. |
| `archive.extract` | Extraction: source archive, output IDs, partial outcomes and lineage. |
| `share.create` | Link creation: subject file IDs, safe permission and expiry fields. |
| `share.update` | Link settings change: allowlisted before and after values. |
| `share.revoke` | Link removal; recipient activity is never inferred. |
| `share.copy_link` | Clipboard action, client-reported only; stores the share reference, never the URL. |
| `file.tags.set` | Before and after tag set for a path. |
| `tag.update` | Tag rename or recolor; affected files are owner-scoped and paginated. |
| `tag.delete` | Tag deletion; affected files keep the historical names. |
| `file.favorite.set` | Boolean before and after. |
| `folder.view.set` | Pinned view change: old and new value. |
| `folder.view.reset` | Single or all pin reset, with the affected folders as subjects. |

Standalone unused-tag creation, folder visits, search queries, listings, polls, HEAD requests,
permission probes and thumbnail or prefetch reads create no events. A denied action appears only
under its actor with the submitted target; it never discloses an inaccessible file's existence,
canonical path or metadata. Mac cancel and acknowledgement requests finalize the original
operation; acknowledgement is protocol housekeeping.

AI organize and AI chat produce ordinary `file.move`, `file.trash` and related rows with
`source: ai` and `evidence: server_confirmed`. Organize applies its proposal through the
ordinary file routes, and a chat action tool writes only from the person's `apply`. A proposal
never applied, and a tool call that only verified arguments, are not events. The applied
outcome is recorded once, in the shared helper that does the work.

`/fs/upload` takes a validated intent, `upload | create | save`, from fdrive callers; other
clients get the endpoint's upload intent. This is provenance, never authorization. Mac, MCP and
Office derive intent from their own operation or session; Office coauthor callbacks never
fabricate an individual author.

### Observations

Each row is visibly an Unknown event or its resolution; it never adopts the observed file's
owner as actor.

| Action | Detail |
| --- | --- |
| `observation.location_missing` | Last-known location; last-seen and detected times; cause and destination unknown. |
| `observation.location_changed` | Proven old and new authorized locations; continuity evidence, actor unknown. |
| `observation.left_scope` | Proven departure, known source only; no outside destination. |
| `observation.content_changed` | Unexpected size or modification time for a known file; unknown author. |
| `observation.continuity_unknown` | Ambiguous rediscovery or hash-relink candidate; no automatic identity merge. |
| `observation.resolved` | Prior observation ID and the proven resolution. |

Observation rows, resolutions included, use outcome `unknown`. Connection or permission
failures stay check state, never invented file events. An observation has no `occurredAt`: its
last-confirmed and detection times bound when the change happened, and detection time orders
it. How observations arise is [below](#how-observations-arise).

### Read aggregation

Folder visits are not recorded. `file.open`, `file.preview`, `file.inspect`, `file.read`,
`file.reveal` and `archive.inspect` are aggregated before they become history, in five-minute
UTC windows keyed by owner, storage identity, file, action, source, hashed session or device
context and the file's generation. Different users, files, actions or revisions never merge; a
mutation increments the generation, so later reads form a new group.

- A durable read window (`activity_read_windows`) holds first and last time and attempt and
  outcome counts. Receipts for logical request IDs keep UI remounts, retries and MCP
  continuations with the same ID from counting twice. MCP calls without a reusable request ID
  are separate calls; distinct explicit gestures each count.
- Range and transport requests correlate with their logical operation; thumbnail, prefetch,
  listing and authorization reads are dropped at admission, not after logging.
- A window seals 60 seconds after it ends. Unfinished attempts become unknown, not successful.
  Sealing appends one immutable event with counts and times. Sealed windows are kept; the
  24-hour receipts are the only per-gesture rows pruned.
- A later server-confirmed completion appends a reconciliation linked to the sealed event with
  its count correction; it never changes that event or replays the read.
- Client reports more than ten minutes old are refused; there is no offline backlog.
- The UI shows the owner's open windows as provisional rows under the reserved event ID, so the
  final event replaces them ("Opened 17 times" with a time range). Exact per-gesture times are
  not kept.
- Downloads and Mac content downloads are one operation per logical transfer, with retries and
  ranges correlated. Mutations, each confirmed autosave and Unknown events are never sampled or
  folded; the UI may collapse autosaves.

Office records the authorized session that submitted a save, not every coauthor; separately
accepted WOPI save callbacks are separate saves. Downloads record delivered bytes at EOF;
partial ranges and interrupted streams stay partial. A failure before a transfer opens is the
API error, not a fabricated download.

## Tables

`app.activity_events` is append-only through the application repositories and API; there is no
history update or delete endpoint. The database role is not a tamper-proof audit-log role.

| Column | Type / meaning |
| --- | --- |
| `id` | UUID primary key |
| `owner_account_id` | Account UUID, never a client-selectable owner |
| `owner_sequence` | bigint, allocated under the owner's stream lock in the append transaction |
| `actor_account_id` | UUID; equals owner for actions, null for Unknown observations |
| `identity_id`, `file_id` | Required storage identity UUID; nullable tracked-file UUID |
| `class`, `action`, `stage`, `outcome` | Taxonomy values; outcome null for intent |
| `source`, `evidence`, `schema_version` | Provenance enums; version 1 |
| `operation_id`, `producer_operation_id` | Copied correlation values, no foreign key to a recovery journal |
| `batch_id`, `parent_event_id` | Nullable UUIDs; batch and parent or reconciliation links |
| `occurred_at` | Nullable timestamptz; an unknown occurrence is never replaced with an invented time |
| `recorded_at`, `sort_at` | Required timestamptz; display order uses occurrence or detection/recording |
| `last_confirmed_at`, `detected_at` | Nullable timestamptz, mostly for observed gaps |
| `before`, `after`, `detail` | Nullable typed JSON facts, 16 KiB combined |
| `safe_error_code` | Nullable bounded code; no exception strings or credentials |
| `count`, `first_at`, `last_at`, `outcome_counts` | Read aggregate count, time range and outcome histogram |
| `idempotency_key` | Required text; unique with owner and storage identity |

Owner and sequence are unique. Database checks enforce the actor rules above. Composite
owner/event and identity/file references protect subjects and related rows.

| Table | Columns / role |
| --- | --- |
| `activity_storage_identities` | `identity_id` PK, `label` (the login's username). Durable snapshot; no foreign key to live logins. |
| `activity_files` | `id` PK, `identity_id`, `kind`, `virtual_path`, `generation`, `revision_id`, `state`, `first_observed_at`, `last_confirmed_at`, `fingerprint`. A live path is unique per identity. State: live, trashed, deleted or unknown. No unique content hash. |
| `activity_file_bridges` | PK identity/namespace/external_id, `file_id`; namespaces Office and desktop. Mac prepare resolves the Finder bridge even while trashed. |
| `activity_file_locations` | `id`, `file_id`, `identity_id`, `virtual_path`, `valid_from`, `valid_until`, `generation`. Internal continuity state; public history comes from owned snapshots. |
| `activity_operations` | `id`, owner, actor, identity, action, source, request digest, producer operation, batch and parent IDs, file, generation, revision, state, before and requested JSON, times, `final_event_id`. Mutable recovery state, independent of history retention. |
| `activity_streams` | Owner PK, `next_sequence`, `history_starts_at`, `retained_from`. Allocates commit-ordered per-owner sequences; no global cursor or count leaks. |
| `activity_event_subjects` | Owner, event, identity and file IDs, role, `subject_ordinal`, path snapshot, revision. PK event/identity/role/ordinal. Ordinals increase within an event so cursor pages include every role; bulk membership is paginated, not packed into event JSON. |
| `activity_revisions` | ID, file, identity, owner, event, `sha256`, size, previous revision. Evidence only; unknown measurements stay null. |
| `activity_lineage` | ID, owner, event, source and target file and identity, kind, evidence. Copy, Save As, archive member and derived edges. |
| `activity_trash_bindings` | File, identity, owner, event, original path, Trash leaf, state (bound, restored or purged). The leaf is the one fdrive moved the item to, which every trash reports; for an item in a folder shared with the login it is in the owner's files, so only the owner's restore or purge resolves it. |
| `activity_observation_state` | Owner, identity, file, generation, discrepancy, evidence fingerprint, event and resolved event, check and detection times. Persistent dedupe and resolution links. |
| `activity_read_windows` | ID, owner, identity, file, action, source, context hash, evidence, generation, bucket start, path, first and last time, counts, `sealed_at`. Mutable until sealed; its ID becomes the event ID. |
| `activity_read_receipts` | PK owner/identity/context hash/request ID, window, outcome, `expires_at`. Retry receipts expire after 24 hours. |
| `activity_outbox` | `event_id` PK, owner and sequence, delivery fields. The stream reads immutable references; one reader never consumes another session's notifications. |
| `activity_exports` | ID, owner, format, state, filters, snapshot sequence, times, row count, error code. A ready snapshot manifest; bytes stream on demand. |
| `activity_export_reads` | PK owner/export/window; an immutable copy of each unsealed read window at export time. |

Names, labels and paths in public events are virtual snapshots; indexer root-relative inputs
pass through the [round trip](../apps/api/src/scoping/round-trip.ts) of configured scopes. Only opaque Office and Finder references enter the bridge. Cookies,
bearer tokens, passwords, raw host paths, file contents and secret share URLs are excluded by the
facts schema. Session and credential context is hashed before read aggregation.

## Writing and recovery

1. Intent commits with the captured owner and identity before the storage call and claims its
   receipt once. A failed intent prevents the I/O. A conflicting or replayed operation ID
   returns a conflict and never retries a possibly completed write. Slow work heartbeats every
   15 seconds.
2. After the storage call succeeds, the registry update, outcome, subjects, revisions, lineage
   and outbox commit in one transaction. If that commit fails, a durable uncertain intent
   remains; the storage call is never retried. An upload still succeeds if the later metadata
   stat fails, with `metadataPending` for placeholder listing metadata.
3. Metadata mutations and their before and after snapshots share one transaction. The operation
   is locked before account, identity and registry locks, so stale-intent recovery cannot race
   the metadata commit. Unchanged metadata yields a skipped outcome.
4. Mac operations (`desktop_operations`) copy activity into these tables at prepare, complete
   and transition; completion and its outcome commit together. History never joins prunable Mac
   receipts, spool files, delayed effects or in-memory jobs. Archive jobs copy their outcome
   before eviction; committed children decide partial completion.
5. Every 30 seconds, maintenance seals read windows and examines non-Mac intents older than ten
   minutes: unstarted work becomes cancelled, interrupted running work unknown. Recovery appends
   evidence and never replays file I/O.
6. The stream row lock allocates the per-owner sequence. Exports take the same lock, freeze the
   sequence and copy unsealed reads in one transaction, so late seals and outcomes cannot cross
   the export cutoff.

Recently opened is built from attributed opens, grouped before limiting to 100 distinct live
paths, and follows known moves. Account deletion follows the account deletion policy; removing
a login keeps its identity snapshot and disables live file actions.

## How observations arise

Changes made outside fdrive reach history only as observations of files the owner already
tracks; nobody else's new files are added. They come from the change journal's rows that the
indexer's watcher, a scan or OCR wrote: the API's reader of the journal
([the API's reader](INDEXER.md#the-apis-reader), [outside.ts](../apps/api/src/events/outside.ts),
[observations.ts](../apps/api/src/activity/observations.ts)) maps both ends of each row through
the login's scopes. Rows fdrive wrote itself are its own actions, recorded already.
Listings and other reads never compare anything with history.

- A move to a readable destination records `observation.location_changed` (`watcher_move`)
  for each tracked file under the source. A destination outside the login's scopes records
  `observation.left_scope` without it; an unreadable one records nothing. A destination where
  another tracked file already lives records `observation.continuity_unknown`; the two are
  never merged.
- A row that says to look again at a path that is gone records `observation.location_missing`
  (`watcher_change`) for tracked files under it, only when its parent can still be listed.
- One at a path that is there compares a readable file's size and modification time with what
  history last confirmed; a difference is `observation.content_changed`.
- A move the watcher could not pair is a delete and a new file: the old path's tracked files
  are missing, and nothing is guessed from a matching hash.

A file seen again after a gap appends `observation.resolved`, linked to the gap. That resolves
where the file is, not who it is: the rediscovered file gets a new ID and the earlier journey
stays unknown, since path, size or hash cannot prove continuity across the gap. Observations
are deduplicated per file, generation and discrepancy (`activity_observation_state`), across
rows and restarts. A row read while an fdrive operation on that path
is prepared or running is dropped; that operation owns the uncertainty. The history page says
that changes made outside fdrive appear once the indexer notices them.

The UI shows the last-known location, last-confirmed time, detection time and evidence, for
example "File no longer found at /Documents/invoice.pdf. It may have moved or been removed
outside fdrive."

## Producers

| Producer | Where | Actions |
| --- | --- | --- |
| File routes | [fs routes](../apps/api/src/fs/routes.ts): upload, mkdir, rename, move, move-many, copy, delete, download, zip, and the exported `moveMany` and `trashMany` | `file.upload`, `file.create`, `file.save`, `folder.create`, `file.rename`, `file.move`, `file.copy`, `file.trash`, `file.delete`, `file.download`, streamed `archive.compress` |
| Trash | [Trash routes](../apps/api/src/trash/routes.ts) and the API's hourly [retention](../apps/api/src/trash/retention.ts); a trash records the leaf the storage's `trash.put` reported | `file.restore`, `file.delete` (reason `retention` when Trash kept it as long as set), `trash.empty` |
| Mac | [desktop routes](../apps/api/src/desktop/routes.ts) and [writes](../apps/api/src/desktop/writes.ts); copied in the [receipt transaction](../packages/db/src/repos/desktop.ts) | the matching file actions, `file.materialize` |
| AI | [chat action tools](../apps/api/src/ai/chat/action-tools.ts) through `moveMany` and `trashMany`; [organize](../apps/api/src/ai/organize/service.ts) through the web's ordinary file routes | file actions with `source: ai` |
| MCP | [MCP routes](../apps/api/src/mcp/routes.ts) wrap the token's storage with [`activityStorage`](../apps/api/src/activity/storage.ts), which records explicit commands only | file actions, `file.read`, `file.inspect`, tags and favorites |
| Office | [Office service](../apps/api/src/office/service.ts) and [writes](../apps/api/src/office/writes.ts) through [activity/office.ts](../apps/api/src/activity/office.ts) | `file.open`, `file.create`, `file.save`, Save As `file.copy` |
| Shares | [share routes](../apps/api/src/shares/routes.ts) | `share.create`, `share.update`, `share.revoke` |
| Metadata | [metadata routes](../apps/api/src/metadata/routes.ts): tags, favorites, folder views, `recents/touch` | `file.tags.set`, `tag.update`, `tag.delete`, `file.favorite.set`, `folder.view.set`, `folder.view.reset`, `file.open` |
| Archives | [archive routes](../apps/api/src/fs/archive-routes.ts): duplicate, compress, extract | `file.copy` (Duplicate), `archive.compress`, `archive.extract` |
| Web gestures | `POST /client-events` from preview, inspector, **Show in folder**, archive preview and copy link | `file.preview`, `file.open`, `file.inspect`, `file.reveal`, `archive.inspect`, `share.copy_link` |
| Observations | [above](#how-observations-arise) | `observation.*` |

A new file command needs its action in the contracts and a history test before release.

## Queries and retention

- Feed indexes start with owner, then `sort_at DESC NULLS LAST, id DESC NULLS LAST`, and
  queries use the same null ordering. Location, file and batch indexes narrow the owner prefix;
  multi-file history also uses subjects. The outbox has an owner and sequence index.
- Historical paths have a trigram GIN index. Cursors bind owner, filters and scope with an
  HMAC; pages default to 50 items and cap at 100. Membership, lineage and revisions page
  separately in groups of 100. Batch totals count each operation's latest outcome once.
- Nothing is pruned except read receipts after 24 hours. Export access expires after 24 hours,
  which prunes neither history nor export snapshot rows. `retained_from` stays null.
- Notifications page tracked files 100 at a time. Nothing starts a recursive scan or hash from
  the timeline.

## API

Paths are under `/api/v1/activity`. Only browser account sessions read history; MCP, Mac and
other tokens get no history API. MCP's `recent_moves` tool reads one slice of it directly: the
token's own login's successful `file.move` events from source `mcp`, inside the token's
folders. There is no owner parameter: another account's event, file or
export ID is not found. Live actions probe only the session's own login and recheck read
access. Responses are uncached.

| Method/path | Contract |
| --- | --- |
| `GET /` | action/source/outcome/from/to/q/cursor/limit filters; items, provisionalReads, nextCursor, historyStartsAt, retainedFrom. |
| `GET /events/:eventId` | One owned event with up to 20 preview subjects and `subjectsTruncated`. |
| `GET /events/:eventId/subjects` | Signed cursor; complete membership in pages of 100. |
| `GET /files/resolve?path=…` | The journey ID of an already tracked path of the session's login, for the inspector. 404 before anything is recorded. |
| `GET /files/:fileId` | Label, kind, last-known and current path, availability, last confirmation, revision. Current path is null when unreadable. |
| `GET /files/:fileId/events` | The feed's filters, limited to that file. |
| `GET /batches/:batchId/events` | The feed plus `batchSummary` `{total, outcomes}`, counting every owned operation in the batch regardless of filters. |
| `GET /files/:fileId/lineage` | Paginated owned edges and safe path snapshots. |
| `GET /files/:fileId/revisions` | Paginated owned revision metadata; no historical bytes. |
| `GET /stream` | Server-Sent Events: committed sequences from the outbox, resumable with a signed `Last-Event-ID` or cursor. Checks authority and polls every two seconds. |
| `POST /client-events` | Logical request UUID, time, path, allowlisted gesture, optional share ID. The server supplies the owner, the session's login and `client_reported` evidence. 300 per account per minute. |
| `POST /exports` | `{format: json\|csv, filters}`, the feed's filters plus fileId or batchId. 202 with a ready manifest ID, format and expiry. 20 per account per minute. |
| `GET /exports/:id` | Manifest state, format and expiry. |
| `GET /exports/:id/download` | JSON or CSV stream with all matching subjects, read windows, lineage and revisions. CSV cells neutralize formulas; an interrupted stream is an incomplete download. 6 per account per minute. |

Rate limits are per API process, and each limiter tracks at most 10,000 accounts, refusing
others while full. Export bytes come from bounded paging at download time, under the same
filters, owner and sequence; session authority is rechecked every two seconds while streaming.
Mutation routes accept the optional upload `intent=upload|create|save`, `x-fdrive-operation-id`
and `x-fdrive-batch-id`.

## Not covered

| Surface | Behavior |
| --- | --- |
| Folder visits, automatic lists and stats, polling, HEAD, thumbnails, prefetch, permission probes | Never events. |
| System settings, maintenance, indexing and OCR | Stay in the administrator log and worker logs; never a user's save. An unexpected change to a tracked file can still be an observation. |
| Public share recipients | Their downloads and uploads are never attributed to the link's owner. A resulting change can be an observation for a tracked file. |
| Cached or offline opens on the Mac | Not observable. Mac downloads (`file.materialize`) and writes are recorded. |
| Indexing off, or rows the journal dropped | Nothing observes outside changes, since only the indexer's watcher and scans journal them; fdrive's own actions are still recorded. Rows older than the journal keeps (30 days) that the API never read are lost to history, and a same-size, same-time change without other evidence is not seen. |
| Commands that do not exist yet | Get their action and history test when they ship. |

## Tests

- API: [activity module tests](../apps/api/src/activity/), including `storage.test.ts`,
  `observations.test.ts`, `admission.test.ts`, `routes.test.ts`, `exports.test.ts` and
  `office.test.ts`; producers' own suites such as `fs/routes.test.ts` and
  `trash/routes.test.ts`.
- PostgreSQL: [activity.test.ts](../packages/db/test/integration/activity.test.ts) and
  [activity-scale.test.ts](../packages/db/test/integration/activity-scale.test.ts), one million
  events across two owners with a one-second p95 ceiling for feed, journey and old-name search,
  a local regression budget rather than a hardware promise.
- Web: `lib/activity/api.test.ts`, `lib/activity/queries.test.tsx` and the browser spec
  [recent-activity.spec.ts](../apps/web/e2e/recent-activity.spec.ts), which also moves a file
  out of the files folder and back, journals each change as the indexer's watcher would, and
  checks the missing and rediscovered evidence.
