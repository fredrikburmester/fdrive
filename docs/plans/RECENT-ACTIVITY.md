# Personal activity and file journeys

Status: proposal, updated 2026-09-14. Planning only. Required by the user: personal history,
comprehensive action tracking, and the ability to trace a file's journey. UI and implementation
choices below are proposed. Source reviewed at local `ad076ce`; upload/Recents behavior was
also compared with cached `origin/main` at `922da2e`. Reconcile newer migrations/protocols before
implementation. This replaces the earlier upload-only scope and short retention proposal.
Native write/recovery changes are being merged concurrently; review the integrated version
before implementation and preserve its existing operation IDs and recovery guarantees.

## Outcome

Answer “Where did my upload go?” and “What have I done with this file since it arrived?” from
one durable personal history. Track meaningful file actions across fdrive's web, API, Office,
MCP and native interfaces. Upload completion remains the first usable slice, but the feature
is not complete until the action coverage and file-journey acceptance criteria below pass.

Operating assumption: fdrive web and the native client are the main access points. Treat their
operations as the normal authoritative history. External interference is an exception that
the first release must represent through explicit **Unknown event** observations.

Example: uploaded `invoice.pdf` → renamed `Invoice September.pdf` → moved to `/Accounts/2026`
→ opened → saved revision 2 → copied to `/Shared` → created a share → moved original to Trash
→ restored. The copy branches into its own journey, linked to its source.

## Personal scope: required

- **Only my actions.** Capture immutable `actorAccountId` from authenticated authority when an
  operation starts, together with its storage identity. Carry this context into jobs, callbacks
  and retries. Never trust a client-supplied user ID or infer the actor from the file owner.
- Enforce private ownership in API/repository reads: feed, file history, lineage, search,
  batch children/counts, cursors, exports and notifications. Action events belong to their actor.
  Unknown-event observations belong to the user's existing personal journey and have no
  invented actor. Admin status grants no exception.
- Another user's actions on the same shared file never appear in my activity. File access,
  sharing or being the uploader does not grant access to another actor's history.
- Identity transfer/relink never reassigns recorded authorship. Old events do not become the
  new account's history. Keep my own recorded history when a file is deleted or a storage
  location becomes unavailable; disable live actions and do not fetch unauthorized new details.
- Other users or system processes can change the file's current state. Display current state
  only when authorized; distinguish it from my recorded actions without exposing their events.
  This is my journey with the file, not a global audit of everyone who ever touched it.
- Unknown observations are the explicit exception to “only my actions”: they explain gaps
  affecting files already in my personal history. Label them as observations, never my actions
  or another person's private activity. Shared-folder access alone must not seed a global feed.
- Recently opened must obey the same actor rule. Existing identity-only rows cannot safely be
  assigned to a new owner after transfer; omit legacy rows whose actor cannot be established.

## Findings and reusable pieces

| Area | Current behavior and implication |
| --- | --- |
| Recents | [Page](../../apps/web/src/components/metadata/recents-page.tsx) and [queries](../../apps/web/src/lib/metadata/queries.ts) track opened paths, not an event history. |
| Uploads | [Store](../../apps/web/src/lib/upload/store.ts) is temporary, preserves original mtime and only passes a parent path to its completion callback. [Panel](../../apps/web/src/components/activity/activity-panel.tsx) lacks upload destination actions. |
| Reveal | [Helpers](../../apps/web/src/lib/files/reveal.ts) already select and scroll in the file browser; reuse them. |
| Events | [Bus](../../apps/api/src/events/bus.ts) is transient. Generic file events are cache invalidation signals, not durable actor-attributed history. |
| Writes | [File routes](../../apps/api/src/fs/routes.ts), [MCP](../../apps/api/src/mcp/file-tools.ts), [Office](../../apps/api/src/office/writes.ts) and jobs have separate entry points. Instrumenting web uploads alone misses actions. |
| File IDs | [Office registry](../../apps/api/src/office/registry-events.ts) has mapped-location UUIDs and move/delete integration. [Office guide](../OFFICE-DEVELOPMENT.md) describes its constraints. It is not a universal registry for every provider/path. |
| Native | [Mac guide](../MACOS.md) describes domain-local catalog UUIDs, path-based server requests and external moves observed as removal/addition. These UUIDs cannot simply become server-wide history IDs. |
| Recovery | [Trash](../TRASH.md) uses provider entries; file contents/version snapshots are a separate [roadmap feature](ROADMAP.md#file-snapshots-and-version-history). |

## What gets recorded

Track user operations and their outcomes, not every HTTP request generated by a screen.
Maintain an explicit coverage inventory mapping every file-related command/endpoint to its
recorder, actor proof, success evidence and regression test; release with no unexplained gaps.

| Action family | Required events and details |
| --- | --- |
| Create and upload | File/folder creation, upload and confirmed replacement; destination, size, batch and revision evidence. Differentiate the shared upload endpoint's create/save/upload callers. |
| Access | Explicit open/preview, folder visit, inspect/info, download/export, and MCP read; distinguish user intent, content delivery and cancellation. An internal stat/thumbnail request is not another user open. |
| Content changes | Web text saves, Office saves, MCP edits and supported native saves; previous/new revision references, size and source application. Preserve each confirmed save; group autosaves only in presentation. |
| Organization | Rename, move, copy and folder operations; before/after paths, source/target object IDs and per-item outcomes. |
| Recovery | Trash, restore, permanent deletion and Empty Trash; stable trash correlation, actual restore destination and per-item outcomes. |
| Sharing | Create/update/revoke share, permission/expiry changes, and explicit copy-link actions when reported by the client. Record safe settings, never passwords, bearer tokens or secret share URLs. Recipient actions are not the owner's actions. |
| Metadata | Tag additions/removals/renames affecting the file, favorite/unfavorite and explicit folder-view changes; previous/new values. Account-wide tag edits relate only to the actor's affected file scopes. |
| Derived files | Compression, extraction, Save As, supported conversion and copy; job/batch relation, inputs, outputs and partial completion. Automatic indexer/OCR processing is a system event, not a personal edit. |
| Attempts | Failed, denied, cancelled, skipped, conflicted and interrupted/unknown operations alongside successes; safe error reason and attempted target, without revealing inaccessible existing-file metadata. |

Unauthenticated traffic is not attributed to a user. Search queries, routine polling and UI
layout interactions are outside a file's journey; explicit file actions from search are covered.
If a user cancels before contacting the server, a client-reported cancellation can be recorded
with that provenance. It must not claim a server-observed storage operation occurred.

## Interface

- **My activity:** replace the old Recents entry with one searchable personal timeline. Proposed
  default: all my storage locations, with filters for location, action, date, outcome and source
  (Web, Office, MCP, Mac). Preserve `/recents` as the Recently opened filtered view.
- **File history:** accessible from file menu, inspector, preview and activity rows; stable URL
  by file ID. Show my chronological actions, previous names/locations, revisions, source and
  outcomes. Keep it reachable through history after Trash/deletion.
- **Journey:** a readable timeline with expandable copy/derived-file branches. Current location
  and last known state appear above it; history retains names and paths as they were then.
  Follow only lineage links visible to the actor. Do not reveal hidden actors or branch counts.
- **Details:** exact time/timezone, source app/device label when known, operation outcome,
  before/after values, related batch and sanitized failure. Distinguish server-confirmed,
  client-reported and uncertain observations. Never call unknown source/device information known.
- **Unknown event:** a neutral, distinct timeline entry showing what changed, the last known
  location, when it was last seen and when the discrepancy was detected. Offer Check again;
  show a confirmed accessible new location only when one is known. Do not invent a destination.
- Group by day and collapse batches/autosaves/repeated reads for readability, with every
  recorded action available on expansion. Grouping must not discard the underlying events.
- Search current and historical names/paths, including a deleted file's recorded name. Use
  indexed, paginated queries; do not stat the entire library to render a feed.
- Offer Open, Show in folder and View history where valid. Restore/revoke or other mutation
  shortcuts use existing current permission/conflict flows; history itself grants no action.
- Upload queue shows storage, final path and Open/Show in folder on success. One notification
  per batch reports mixed results and links to the corresponding history. No automatic page
  navigation; clearing/collapsing the queue does not erase recorded events.
- Show history starting date, explicit gaps and stale/offline/error states. No invented events
  from old mtime/index records; file upload completion appears before indexing/thumbnail work.
- Provide actor-scoped JSON/CSV history export, with sensitive fields excluded and safe CSV
  cell encoding. Export the selected scope completely or clearly report a bounded export.

## Stable files and lineage

1. Introduce a server-side tracked-file registry independent of indexing and active browser
   state. Assign a UUID at first observed authorized operation; an existing file begins as
   “History starts here”, not “Created”. Include files and folders on SFTPGo and WebDAV.
2. Keep UUID through known rename/move and Trash/restore, including folder descendants. Store
   historical location changes separately from current location. Permanent deletion tombstones
   the object; a new file at the same path receives a new ID. Do not merge by filename/hash.
3. Copy/Save As creates a new UUID and a lineage edge to the source. Model archive extraction
   and conversion as derivation, not rename. Cross-provider transfers have linked source/target
   identities and explicit copy/delete stages; partial completion cannot masquerade as a move.
4. Prefer proven provider object IDs when supported; otherwise maintain canonical virtual-path
   bindings with lifecycle generations and confirmed operation results. Treat identity/provider
   boundaries explicitly; matching shared-folder paths never establish equivalence or access.
5. Bridge existing Office and Mac IDs with explicit mappings, preserving their stable IDs and
   authorization contracts. Do not repurpose an Office mapped-root key for unindexed WebDAV,
   or reset a Mac domain/catalog. The history registry is the common reference for new events.
6. Capture revision references for confirmed writes: provider version/ETag where trustworthy,
   hash when already available or computed during the streamed write, size and prior revision.
   No unbounded content reads for history. Missing revision evidence stays unknown. A history
   of revisions does not imply old bytes are stored or that content diff/rollback is available.
7. Bind Trash results to opaque provider trash IDs using verified provider evidence. Extend the
   operation result if necessary; do not correlate by basename or time alone. Unproven restores
   must show uncertain continuity instead of silently attaching to the wrong prior object.

## Durable operation recording

- Add an operation journal, append-only activity events, tracked-file/location records and
  lineage/revision references in PostgreSQL. Fields include immutable private owner, nullable
  actor, action/observation classification, storage identity,
  file IDs, operation/batch/parent IDs, action, source, timestamps, outcome, evidence/provenance
  and bounded before/after details. Never store raw content, credentials or physical paths.
  Every query requires `ownerAccountId = principal.accountId`. For actions, owner equals the
  authenticated actor; for observations, actor is null and owner derives from that account's
  already recorded journey. The observer service is provenance, not the human actor.
- Route every supported operation through a shared recorder at its authoritative service
  boundary. Carry validated intent/source separately from authorization. Instrument web/API,
  MCP, Office and native producers; a storage wrapper alone cannot tell preview from download.
  Adapt the incoming [native operation journal](../../apps/api/src/desktop/writes.ts) and
  metadata recovery machinery into this recorder instead of creating a competing retry or
  publication protocol. Reuse native operation IDs and separate private history from recovery.
- Durably record an authorized operation's intent before upstream mutation. If that initial
  write fails, do not begin the mutation. After confirmed storage success, commit outcome,
  registry/location changes, revisions, lineage and an event outbox together. Deliver SSE
  from the outbox with actor-scoped reconnect cursors; polling remains a recovery path.
- An upstream write and PostgreSQL are not atomic. If the outcome transaction fails after
  bytes were saved, report storage success with history pending, retain the durable intent,
  and reconcile metadata without repeating the write. Use operation IDs and unique event
  constraints to deduplicate retries/callbacks; this does not imply exactly-once provider I/O.
- On restart, reconcile unfinished operations only with sufficient provider/version evidence.
  Record a separate reconciliation result. If it cannot be proven, preserve Unknown/interrupted
  rather than invent Success/Failure from a current stat. Never overwrite historical facts.
- Capture read intent before delivery where possible; finalize stream outcomes. A completed
  server response means bytes delivered, not proof that a browser saved them to disk. Client
  preview acknowledgments remain distinct, and repeated range requests share one operation.
- Capture actor context for delayed jobs and Office sessions; recheck current authority before
  storage access. Coauthor/editor callbacks identify the accountable authorized operation,
  not automatically every human editor of the document. Unprovable authorship remains unknown.
- Append-only describes normal application behavior, not cryptographic tamper-proof storage.
  Explicit account deletion/retention policy remains possible and must be visible.

## Coverage limits and retention

- fdrive web/native are the primary access paths; comprehensive known-operation coverage is
  the priority. External SFTP/WebDAV clients, server-side changes and offline/local cached opens
  are not comprehensively observable from the API. Represent detected external discrepancies
  with the required unknown-event mechanism below, without claiming exhaustive external history.
- Native downloads can be observed, but background hydration/refresh is not evidence that a
  person opened the file. Log truthful native operations; only emit a user-open event when
  the platform provides a reliable signal. Report this boundary in the coverage inventory.
- Authorized observations may establish that a location/revision changed outside recorded
  activity. Show an unattributed gap when appropriate; never fabricate an actor or merge
  ambiguous external rename/delete/recreate events. Other users' events remain private.
- Preserve journey metadata by default, including deleted-file history. Remove the former
  90-day/10,000-event silent cap. Use indexed keyset pagination, bounded batch children,
  partitioning/archival and explicit configurable retention. If policy truncates history,
  show its cutoff and preserve enough tombstone/lineage structure to avoid false continuity.
- Optimize separately for private owner/time, owner/file/time and historical-path lookup. Avoid
  expensive live checks or full hashes per history row; live actions enforce current access.

## Unknown events and reconciliation: required

Compare the last confirmed registry state with authorized observations from normal web reads,
native refresh and existing trusted change signals. Reconcile pending fdrive operations first:
an in-flight move, delayed callback or missing completion response must not become a false
external event. Background reconciliation is bounded to tracked locations and current grants.

| Observation | Timeline treatment |
| --- | --- |
| File absent from its last known location, cause unproven | **Unknown event — location unavailable.** “File no longer found at /Documents/invoice.pdf. It may have been moved or removed outside fdrive.” Keep destination unknown. |
| Reliable stable-ID or trusted move evidence proves a new authorized location, with no recorded operation | **Unknown event — moved outside recorded activity.** Show old/new virtual paths and actor unknown; preserve the file ID. |
| Evidence proves departure from the authorized scope but no accessible destination | **Unknown event — left tracked location.** Preserve the last known path and disable Open; never expose an out-of-scope destination or probe beyond grants. |
| Same known object has an unexpected revision | **Unknown event — content changed outside recorded activity.** Show only available version/size evidence, not an invented save action or author. |
| A matching-looking file appears but identity is ambiguous | Keep a separate observed object; state continuity could not be established. Matching name, size, mtime or hash is insufficient to join journeys automatically. |
| Previously missing object is identified again with reliable evidence | Append a linked resolution, update current location and restore permitted actions. Keep the original unknown observation in history. |

- “Outside scope” is an explanation only when proven. A not-found response alone cannot
  distinguish move, deletion or another cause. Unknown events describe observations first.
- A failed/incomplete scan, timeout or offline provider is a check failure, not evidence of
  disappearance. Permission denial means access unavailable, not moved/deleted. Require a
  trustworthy successful observation and confirmation before declaring an unexplained absence;
  retain the last known state during transient failures and concurrent refreshes.
- Store last confirmed observation time, detection time, evidence source, relevant known
  revision/location and an optional occurrence interval. Display “Detected at”, not an exact
  action time invented from mtime or scan time.
- Deduplicate by tracked file, last confirmed state and discrepancy; repeated refreshes update
  operational check state without creating identical timeline events or repeated notifications.
- Resolution appends a new event linked to the earlier discrepancy. Never silently rewrite
  Unknown into a supposed user action. A later journal reconciliation can link the proven
  operation while retaining the observation/reconciliation sequence.
- Maintain personal visibility for observations and resolutions. If another person's shared
  file action explains the change, do not expose that action or actor through this mechanism.

## Delivery sequence

1. **Foundation and one full journey:** stable identity, actor isolation, event taxonomy,
   journal/outbox and operation recovery. Prove upload → rename → move → Trash → restore,
   including crash points and another account sharing the same folder. Include the unknown-
   event state model and one external-move/disappearance reconciliation path in this slice.
2. **Immediate recovery and history UI:** completion actions, My activity, file history,
   filters, historical-name search, pagination and restart/device continuity.
3. **Comprehensive producers:** instrument every coverage-matrix action across currently
   supported web/API/MCP/Office/native operations; include failures, reads, shares, metadata,
   copies and jobs. Coordinate native writes with its implementation plan. Unsupported
   platform signals stay explicitly documented; upload-only delivery is not completion.
4. **Journey depth and qualification:** lineage/revisions, grouping, export, large-history
   queries, retention, real-provider recovery and mobile/accessibility verification.

## Acceptance

- Trace the example journey through renamed files and folder ancestors; search by the original
  name, follow a copy branch, delete/recreate the original path and prove the histories differ.
- Two accounts sharing a folder see only their own actions. Cover admin users, guessed IDs,
  lineage edges, export, filters/counts, cursors, callbacks and identity transfer during a job.
- Deleted/unlinked files retain my recorded history with live actions appropriately unavailable.
  Legacy Recents migration must not expose a previous account's opened paths.
- Test the recorder before/after each provider boundary and outcome commit: restart, dropped
  response, duplicate callbacks, database outage, cancellation, conflict and partial batch.
  No unrecorded begun mutation when intent persistence fails; no duplicate provider retry
  to repair history; unresolved outcomes remain explicit.
- Each action/producer has an end-to-end coverage case with correct actor, file identity,
  source, time, outcome and before/after details. Distinguish fixtures from real integrations.
- Record native/API reads honestly: cached local opens, prefetch, thumbnail requests and
  downloads do not silently become verified human opens. External changes never fabricate
  personal events. Test shared Office saves without claiming unverified individual authorship.
- Move a tracked file externally within authorized storage, move it beyond tracked scope,
  delete it, change its bytes and recreate its path. Verify known evidence versus unknown
  continuity, last-known/detected timestamps, no guessed destinations and no scope escape.
- Repeat refreshes and restart during a discrepancy: one unknown event, then a linked
  resolution if identity is proven. Incomplete scans, permission errors, provider outages,
  pending fdrive moves and delayed callbacks must not manufacture an external move/deletion.
- Upload old-dated files with indexing/AI disabled; completion/reveal/history work immediately.
  Clear the queue, reload, reconnect and open a second browser: the journal remains available.
- Exercise 1,000-file batches and at least 1 million events across multiple accounts; capture
  query plans, bounded response/stat counts, first-page and historical-name search timings.
  Set explicit performance budgets from this fixture before qualification.
- Inspect 320/393/768px and desktop, light/dark, long paths/names, keyboard, accessible labels,
  44px mobile actions and no horizontal overflow. Verify grouped details and lineage navigation.
- Use orchestration helpers: focused checks, then `application`, `integration`, affected
  `browser`, native checks when changed, and `workflow`. Verify real PostgreSQL/SFTPGo/WebDAV,
  relevant Office/MCP/native paths and the real dev UI. Preserve all existing quality gates.

Planning verification covers source/document checks only; runtime and completeness remain
unverified until implementation. No application implementation, commit or deployment here.
The latest amendment passed local link/anchor and whitespace checks. The full workflow gate
was not rerun while another task's merge left unrelated conflicts in the shared checkout.
