# Activity event taxonomy

Implemented contract for [personal activity](RECENT-ACTIVITY.md). Exact wire/storage enums
live in [personal-activity.ts](../../packages/contracts/src/personal-activity.ts). S2/S3/S4
refer to independently shippable delivery slices. The slice 1 completion UI has no persistence dependency.

## Envelope enums

- `class`: `action | observation`. Actions require authenticated actor = private owner;
  observations require actor null and an existing personal journey for the owner.
- `stage`: `intent | outcome | reconciliation`. Intent has null outcome. Observation detection
  uses outcome stage; its later resolution uses reconciliation and links the earlier event.
- `outcome`: `success | failed | denied | cancelled | skipped | conflict | partial | unknown`.
  Outcomes describe the named operation, not whether an HTTP request returned 200.
- `source`: `web | api | ai | office | mcp | native | indexer | refresh`. **Since 26bc01e**
  `ai` marks a mutation the person approved in AI organize or AI chat; `detail` names which one
  and its run or conversation. Without it an applied organize run is indistinguishable from a
  hand-made move, which is the first question anyone asks of it. The actor stays the
  authenticated account: the assistant proposes, the person applies.
- `evidence`: `server_confirmed | client_reported | watcher_move | watcher_change |
  sha256_relink | provider_version | refresh_comparison | reconciled`.
  Evidence is structured with bounded detail; its label does not itself grant access.
- `schemaVersion`: `1`. The current client validates this version and the enumerated actions;
  future taxonomy versions require a compatible client/contract update, never reinterpretation
  as a successful upload.

## Action names

All mutating actions support intent/outcome; conflicts, cancellation, errors and partial bulk
results use the same action name with the correct outcome. Batch rows summarize children;
they do not replace per-file mutation facts. No generic `job.completed` duplicates the original
action: the runner completes its `archive.compress` or `archive.extract` operation.

| Action | Meaning and required detail | First slice |
| --- | --- | --- |
| `file.upload` | User-supplied upload; target, size, batch, revision evidence. Replacement flag only when provider result proves it. | S2 |
| `file.create` | New empty/text/document file; actual destination and creation source. | S2 core; S3 Office/MCP |
| `folder.create` | Explicit folder creation; implicit upload parents are details of that upload, not invented extra gestures. | S2 |
| `file.save` | Confirmed content update; prior/new revision evidence, size, editor/source. | S2 core/native; S3 Office/MCP |
| `file.rename` | New name within parent; before/after virtual path, same file ID. Applies to folders too. | S2 |
| `file.move` | Relocation; both storage identities/paths when applicable. Cross-provider copy/delete stages remain explicit. | S2 |
| `file.copy` | Copy, Duplicate or Save As; new target ID plus source edge; variant in details. | S2 core; S3 other producers |
| `file.trash` | Recoverable removal; accepted provider-specific Trash binding and prior path. | S2 |
| `file.restore` | Restored item; exact Trash binding, actual target, same ID when correlation is established. | S2 |
| `file.delete` | Permanent removal; tombstone. A missing/denied request records only the actor's attempted path. | S2 |
| `trash.empty` | Parent operation with bounded per-item `file.delete` children and exact success/failure counts. | S2 |
| `file.open` | Explicit editor/document open; not proof of a save. Legacy `recents/touch` is client-reported intent. | S2 recents; S3 other opens |
| `file.preview` | Explicit preview gesture/acknowledgment; separate from transport prefetch. | S3 |
| `file.inspect` | Explicit Info/inspector action; background `stat` does not emit it. | S3 |
| `file.read` | Explicit MCP content read, including related continuation requests. | S3 |
| `file.download` | Explicit download/export of original bytes; outcome describes server delivery, not disk save. | S3 |
| `file.materialize` | Native content hydration; no claim of a human open. | S3 |
| `file.reveal` | User's Show in folder action; client-reported, no folder-visit cascade. | S3 |
| `archive.inspect` | Explicit archive listing/preview; internal entry probes are not separate gestures. | S3 |
| `archive.compress` | Archive job or streamed ZIP; inputs, result if stored, variant, byte/child counts. | S3 |
| `archive.extract` | Extraction; source archive, output IDs, partial outcomes and lineage. | S3 |
| `share.create` | Authenticated share creation; subject file IDs, safe permission/expiry fields. | S3 |
| `share.update` | Authenticated share settings change; allowlisted before/after values. | S3 |
| `share.revoke` | Authenticated share removal; never infer recipient activity. | S3 |
| `share.copy_link` | Explicit clipboard action, only client-reported; store share reference, never secret URL. | S3 |
| `file.tags.set` | Before/after tag ID/name set for a path. | S3 |
| `tag.update` | Actor's tag rename/recolor; affected-file relations are owner-scoped and paginated. | S3 |
| `tag.delete` | Actor's tag deletion; affected-file relations retain historical names. | S3 |
| `file.favorite.set` | Boolean before/after; applies to favorite/unfavorite. | S3 |
| `folder.view.set` | Explicit pinned view change; old/new value. | S3 |
| `folder.view.reset` | Explicit single/all pin reset; parent/subject relations for bulk scope. | S3 |

Standalone unused-tag creation, folder visits, search queries, lists/polls, HEAD requests,
permission probes and thumbnail/prefetch reads do not create file-journey events. An attempted
action whose API is denied can appear only under its authenticated actor and submitted target;
do not disclose inaccessible file existence, canonical path or metadata. Native cancel/ack
endpoints finalize the original operation; acknowledgment is protocol housekeeping.

AI organize and AI chat produce ordinary `file.move`, `file.trash` and related rows with
`source: ai` and `evidence: server_confirmed`. Both are approval-gated: organize applies its
proposal through the ordinary fs routes, and a chat action tool writes only from the person's
`apply`. A proposal that was never applied, and a tool call that only verified arguments
against storage, are not events. Record the applied outcome once, at the shared helper that
performs the work, not once per agent turn.

For `/fs/upload`, the validated intent is `upload | create | save` for fdrive callers;
legacy clients remain compatible and use the endpoint's documented upload intent. This is
provenance, never authorization. Native/MCP/Office adapters derive intent from their own
operation/session context; coauthor callbacks must not fabricate an individual human author.

## Observation names

Every row is visibly an Unknown event or its resolution; it never adopts the observed file's
owner as actor. Provider-specific admission rules live in the main plan.

| Action | Required observation detail |
| --- | --- |
| `observation.location_missing` | Last-known virtual location; last-seen/detected times; cause and destination unknown. |
| `observation.location_changed` | Proven old/new authorized locations; evidence of continuity, actor unknown. |
| `observation.left_scope` | Proven departure, known source only; no outside-scope destination. |
| `observation.content_changed` | Unexpected revision/size evidence for a known object; unknown author. |
| `observation.continuity_unknown` | Ambiguous rediscovery/hash-relink candidate; no automatic identity merge. |
| `observation.resolved` | Prior observation ID and proven resolution; may link a reconciled fdrive operation. |

Detection rows use outcome `unknown`; proven resolution uses `success`. Runtime connection or
permission failures remain check state, not invented file mutations. Preserve `occurredAt`
when known; otherwise use detection time for display order and mark the occurrence interval.

## Write-time read aggregation

Folder visits are dropped. Aggregate `file.open`, `file.preview`, `file.inspect`, `file.read`,
`file.reveal` and `archive.inspect` before appending durable history, using five-minute UTC admission-time
windows keyed by owner account + storage identity + file ID + action + source + authenticated
session/device context + tracked location/content generation. Never merge different users,
files, actions or revisions. A mutation increments generation so later reads form a new group.

- A durable read-window table holds first/last time and attempt/outcome counts. Keep bounded
  idempotency receipts for logical gesture/request IDs, so UI remounts, retries and MCP chunk
  continuations with the same logical receipt do not double-count one intent. MCP calls without
  a reusable request ID are separate observed calls; the server cannot infer client retries. Distinct explicit gestures increment the count.
- Correlate range/transport requests with their logical operation; suppress thumbnail, prefetch,
  listing and authorization reads at admission, not after logging them.
- A window seals after its end plus a 60-second drain period. Unfinished attempts become
  unknown, not successful. Append one immutable event with counts and times, transactionally
  mark the window sealed. Sealed buffers are retained; 24-hour receipts are the only
  per-gesture rows with automatic cleanup. There is no history or buffer pruning policy.
- A later server-confirmed completion appends a reconciliation linked to the sealed event,
  with its count correction; it cannot mutate that event or replay the read. Late client
  reports still follow admission expiry. Provisional uncertainty must not silently become success.
- Reject client reports older than the supported 10-minute admission window; do not invent an
  offline backlog. Keep dedupe receipts 24 hours, beyond admission/sealing, then prune them.
  Restarts finalize durable windows; sealed windows cannot accept late mutations.
- The UI can show the owner's open windows as provisional summaries; use the reserved event
  UUID so the final event replaces that provisional row. Show “Opened 17 times” and time range.
  Counts and first/last times are retained; exact per-gesture timestamps are intentionally not.
- Downloads/materializations keep one operation per logical transfer with retries/ranges
  correlated. Mutations, their individual confirmed autosaves, and Unknown events are never
  silently sampled or folded by this read-volume rule. Presentation may collapse autosaves.

Regression: 1,000 unique opens in one window yield count 1,000 in one sealed event; replaying
those request IDs changes nothing. Different revision/session/outcome details stay truthful,
and folder navigation/prefetch generate zero events. See the schema for the mutable windows
versus append-only history boundary.

Admission limits: 300 client reports per account per minute; 12 explicit rechecks per account
per minute, per API process. Buckets cap at 10,000 accounts and fail closed at capacity.
A complete refresh compares at most 100 tracked children, live-checks at most eight changes,
and rotates its cursor. Polls themselves never become user events.

Office records the authorized session that submitted a save, not all coauthors. WOPI has no
general stable save-attempt ID: separately accepted save callbacks are separate saves.
Downloads record delivered bytes at EOF; partial ranges and interrupted streams remain partial.
Preflight failures before a transfer is opened are covered by the API error, not a fabricated
successful download.
