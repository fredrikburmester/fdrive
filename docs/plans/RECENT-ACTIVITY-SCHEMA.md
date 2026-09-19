# Personal activity: implemented schema and API

Source of truth: [Drizzle schema](../../packages/db/src/schema/activity.ts), its generated
migrations, [contracts](../../packages/contracts/src/personal-activity.ts) and
[repositories](../../packages/db/src/repos/activity.ts). The [taxonomy](RECENT-ACTIVITY-EVENTS.md) and [invariants](RECENT-ACTIVITY.md) apply to
every producer.

**Since 26bc01e** main has taken `0010`–`0015` for unrelated work, so the branch's five
activity migrations are regenerated as a single `0016_personal_activity` against current main.
The generated DDL matches the branch's five files object for object, including the trigram GIN
index and the descending null orderings; only the numbering and the snapshots move.

The branch's schema also left every activity foreign key without a covering leading-column
index, which the `migrate` integration gate rejects. The schema now carries one index per
otherwise uncovered key.

## Event columns

`app.activity_events` is append-only through the application repositories and API. There is no
ordinary history UPDATE/DELETE endpoint. The DB role is not a tamper-proof audit-log role.

| Column | Type / meaning |
| --- | --- |
| `id` | UUID primary key |
| `owner_account_id` | Account UUID, never a client-selectable owner |
| `owner_sequence` | bigint, allocated under the owner's stream lock in the append transaction |
| `actor_account_id` | UUID; equals owner for actions, null for Unknown observations |
| `identity_id`, `file_id` | Required durable storage identity UUID; nullable tracked-file UUID |
| `class`, `action`, `stage`, `outcome` | Taxonomy values; outcome null for intent |
| `source`, `evidence`, `schema_version` | Provenance enums; version 1 |
| `operation_id`, `producer_operation_id` | Copied correlation values, no FK to a recovery journal |
| `batch_id`, `parent_event_id` | Nullable UUIDs; batch and parent/reconciliation links |
| `occurred_at` | Nullable timestamptz; unknown occurrence is never replaced with invented action time |
| `recorded_at`, `sort_at` | Required timestamptz; display sort uses occurrence or detection/recording |
| `last_confirmed_at`, `detected_at` | Nullable timestamptz, particularly for observed gaps |
| `before`, `after`, `detail` | Nullable typed JSON facts, combined 16 KiB budget |
| `safe_error_code` | Nullable bounded code; no exception strings or credentials |
| `count`, `first_at`, `last_at`, `outcome_counts` | Read aggregate count, time range and outcome histogram |
| `idempotency_key` | Required text; unique with owner + storage identity |

Owner + sequence is unique. DB checks enforce action actor ownership and null observation
actors. Composite owner/event and identity/file references protect subjects and related rows.
All personal tables are separate from actorless administrator `app.system_events`.

## Supporting tables

All UUIDs below are PostgreSQL UUIDs; times are `timestamptz`. Read the linked schema for exact
FK/index definitions. Private ownership is account-based; storage identity accompanies it.

| Table | Columns / role |
| --- | --- |
| `activity_storage_identities` | `identity_id` PK, `provider_id`, `provider_type`, `label`, `retired_at`. Durable snapshot; no cascading FK to live identities/providers. |
| `activity_files` | `id` PK, `identity_id`, `kind`, `virtual_path`, `generation`, `revision_id`, `state`, `first_observed_at`, `last_confirmed_at`, `fingerprint`. Live path is unique per identity. State: live/trashed/deleted/unknown. No unique content hash. |
| `activity_file_bridges` | PK identity/namespace/external_id, `file_id`; namespaces Office, desktop, provider. Native prepare resolves the Finder bridge even while trashed. |
| `activity_file_locations` | `id`, `file_id`, `identity_id`, `virtual_path`, `valid_from`, `valid_until`, `generation`. Internal continuity state; public history comes from owned snapshots. |
| `activity_operations` | `id`, owner/actor/identity, action/source/request_digest, producer_operation_id/batch_id/parent_operation_id, file_id/file_generation/revision_id, state, before/requested JSON, created_at/updated_at/final_event_id. Mutable recovery state, independent of history retention. |
| `activity_streams` | Owner PK, next_sequence, history_starts_at, retained_from. Allocates commit-ordered per-owner sequences. No global cursor/count leak. |
| `activity_event_subjects` | owner/event/identity/file IDs, role, subject_ordinal, virtual_path_snapshot, revision_id. PK event/identity/role/ordinal. The writer assigns globally increasing ordinals within each event so cursor pages include every role. Bulk membership is paginated, not packed into event JSON. |
| `activity_revisions` | id, file/identity/owner/event, provider_version, sha256, size, previous_revision_id. Evidence only; no original bytes, diffs or rollback. Unknown measurements remain null. |
| `activity_lineage` | id, owner/event, source_file_id/source_identity_id, target_file_id/target_identity_id, kind/evidence. Copy, Save As, archive member and derived edges. |
| `activity_trash_bindings` | file/identity/owner/event, strategy, original_virtual_path, trash_virtual_leaf, state. Full SFTPGo path plus provider timestamp leaf is accepted; ambiguous binding remains unresolved. WebDAV and S3 both record the leaf fdrive constructed through the shared move layout. |
| `activity_observation_state` | owner/identity/file, prior_generation, discrepancy, evidence_fingerprint, event_id/resolved_event_id, last_check_at/last_confirmed_at/detected_at/check_error. Persistent dedupe and resolution links. |
| `activity_read_windows` | id, owner/identity/file, action/source/context_hash/evidence, file_generation/bucket_start, virtual_path, first_at/last_at/attempted_count/outcome_counts/sealed_at. Mutable until sealed; ID becomes the event ID. |
| `activity_read_receipts` | PK owner/identity/context_hash/request_id, window_id, outcome, expires_at. Logical retry receipts expire after 24 hours. |
| `activity_outbox` | event_id PK, owner/owner_sequence, available_at/delivered_at/attempts. SSE reads immutable fan-out references; one reader never consumes another session's notifications. Delivery fields are reserved, not per-reader acknowledgments. |
| `activity_exports` | id, owner, format/state/filters/snapshot_sequence, created_at/expires_at/row_count/safe_error_code. A ready snapshot manifest; download bytes are streamed on demand. |
| `activity_export_reads` | PK owner/export_id/window_id; payload is an immutable copy of each unsealed read aggregate at export creation. No reference to a later-mutated buffer. |

The schema has 17 activity tables. Names, labels and file paths in public events are virtual
snapshots; indexer and Office root-relative inputs pass through configured round-trip mapping.
Only opaque Office/Finder/provider references enter the bridge. Cookies, bearer tokens,
passwords, raw host paths, file contents and secret share URLs are excluded by the facts schema.
Authenticated session/credential context is hashed before read aggregation.

## Transactions and recovery

1. Commit intent with captured owner/identity before provider mutation; claim its receipt once.
   An intent failure prevents I/O. Conflicting/replayed mutation IDs return conflict, never
   retry a possibly completed file write. Adapters heartbeat slow work every 15 seconds.
2. After actual provider success, update registry, append outcome/subjects/revisions/lineage
   and outbox in one DB transaction. A history commit failure leaves a durable uncertain
   intent; it never retries provider I/O. Upload acknowledgment still returns success if the
   later metadata stat fails, with `metadataPending` for placeholder listing metadata.
3. Metadata mutations and their actual before/after snapshots share one transaction. Lock
   the operation before account/identity/registry locks, so stale-intent recovery cannot
   race the metadata commit. Unchanged metadata yields a skipped outcome.
4. Native `desktop_operations` prepare/complete/transition copies activity into the new tables.
   Completion and immutable outcome commit together. History never joins prunable native
   receipts, spool files, delayed effects or in-memory jobs. Jobs copy the original archive
   outcome before eviction; committed children determine partial completion.
5. Every 30 seconds, maintenance seals windows and examines non-native intents older than
   ten minutes. Unstarted work becomes cancelled; interrupted running work becomes unknown.
   Recovery appends later evidence and never replays file I/O.
6. The stream row lock allocates per-owner sequence at append. Exports take that same lock,
   freeze its sequence and copy unsealed reads in one transaction. Late seals/outcomes cannot
   cross the export cutoff or make a copied open window disappear.

Identity relink never transfers authorship. Existing tags/favorites keep their current transfer
behavior. Legacy Recents rows have no provable actor and are not imported. New Recents projects
attributed opens, groups before limiting to 100 distinct live paths, and follows known moves.
Same-path rediscovery resolves a missing-location check, creates a distinct target UUID, and
keeps the earlier file unknown; path/size/hash cannot prove continuity across the gap.
Account deletion uses the existing explicit account-deletion policy; ordinary unlink/provider
removal preserves durable identity snapshots and disables current file actions.

## Queries, volume and retention

- Feed indexes start with owner, then `sort_at DESC NULLS LAST, id DESC NULLS LAST`.
  Queries use the same null ordering so PostgreSQL can use them without a full sort.
  Location/file/batch indexes narrow the owner prefix; multi-file history also uses subjects.
- The outbox has an owner/sequence index for reconnect polling.
- Historical virtual paths have a trigram GIN index. Cursors bind owner, all filters and scope
  with HMAC; page size defaults to 50 and caps at 100. Membership, lineage and revisions page
  independently in groups of 100. Batch totals count each operation's latest outcome once.
- No history cutoff is enabled. History, sealed windows, operation metadata and outbox rows
  are retained. Only the explicitly specified 24-hour read receipts are pruned. Export access
  expires after 24 hours; that does not prune event history or export snapshot rows.
- A future archival/deletion policy must expose its cutoff and preserve tombstone/lineage
  boundaries. `retained_from` currently remains null. This feature adds no automatic archive,
  file-byte deletion, or administrator purge API.
- Observer refresh uses at most 100 tracked candidates and eight fresh live checks per call.
  SFTPGo watcher subtree evidence pages 100 known files at a time. There is no recursive
  scan/hash discovery launched from the timeline. Full bulk registry updates still grow with
  tracked membership; they are database work, not an unbounded provider stat fan-out.

## API surface

All paths below have prefix `/api/v1/activity`. Only authenticated browser account sessions
can read personal history; MCP/native/global credentials gain no cross-storage history API.
There is no owner parameter. Foreign event/file/export IDs return not found. Live actions
recheck the identity's current owner and provider read access. Responses are uncached.

| Method/path | Contract |
| --- | --- |
| `GET /` | identityId/action/source/outcome/from/to/q/cursor/limit filters; items, provisionalReads, nextCursor, historyStartsAt, retainedFrom, coverage. |
| `GET /locations` | Owned historical storage identity IDs/labels, including disconnected locations and bulk/read-only membership. |
| `GET /events/:eventId` | One owned event with up to 20 preview subjects and subjectsTruncated. |
| `GET /events/:eventId/subjects` | Signed cursor; complete membership in pages of 100. |
| `GET /files/resolve?identityId=…&path=…` | Resolves an already personally tracked current virtual path to its journey UUID for Inspector. |
| `GET /files/:fileId` | label, kind, lastKnownPath, currentPath, availability, lastConfirmedAt, revisionId. Current path null when unreadable/unlinked. |
| `GET /files/:fileId/events` | Same feed filters and owned file-subject predicate. |
| `GET /batches/:batchId/events` | Same feed plus batchSummary `{total, outcomes}`; counts are all owned operations in the batch, independent of narrowed list filters. |
| `GET /files/:fileId/lineage` | Paginated owned edges and safe source/target path snapshots. |
| `GET /files/:fileId/revisions` | Paginated owned revision metadata; no historical bytes. |
| `GET /stream` | SSE invalidation references, signed `Last-Event-ID` or cursor. Reads commit-ordered outbox pages, checks authority, polls every two seconds. |
| `POST /client-events` | Captured identity, logical request UUID, at, path, allowlisted gesture, optional shareId. Server supplies owner and client_reported evidence. 300/account/minute/process. |
| `POST /files/:fileId/recheck` | Current owner/read-authorized bounded check; `{checked: boolean}`. 12/account/minute/process. |
| `POST /exports` | `{format: json|csv, filters}`; same non-pagination filters plus fileId/batchId. Returns 202 with ready manifest ID, format and expiry. |
| `GET /exports/:id` | Owned manifest state/format/expiry. No rowCount promise or background generation worker. |
| `GET /exports/:id/download` | Snapshot JSON/CSV stream, including all matching subjects, read aggregates, lineage and revisions. CSV cells neutralize formulas; interrupted streams are incomplete downloads. |

Export manifests become ready immediately because bytes are generated by bounded paging at
download time. This replaces the proposed asynchronous artifact worker without loading history
into memory. Filter, owner and sequence predicates also apply to lineage and revision export.
Open read aggregates are frozen separately and filtered consistently. Session authority is
checked at startup and at two-second intervals while streaming.

Web routes: `/activity`, `/activity/files/:fileId`, `/activity/batches/:batchId`.
`/recents` retains the Recently opened response shape. Existing mutation routes accept the
optional upload `intent=upload|create|save`, `x-fdrive-operation-id`, and `x-fdrive-batch-id`.
