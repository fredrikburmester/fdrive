import type {
  ActivityFacts,
  PersonalActivityAction,
  PersonalActivityEvidence,
  PersonalActivityOutcome,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts, appSchema } from "./app.js";

const time = (name: string) => timestamp(name, { withTimezone: true });
const owner = () =>
  uuid("owner_account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" });

/** Durable identity snapshots deliberately have no FK to live logins/providers. */
export const activityStorageIdentities = appSchema.table("activity_storage_identities", {
  identityId: uuid("identity_id").primaryKey(),
  providerId: uuid("provider_id").notNull(),
  providerType: text("provider_type").notNull(),
  label: text("label").notNull(),
  retiredAt: time("retired_at"),
});
export const activityFiles = appSchema.table(
  "activity_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => activityStorageIdentities.identityId),
    kind: text("kind").$type<"file" | "dir">().notNull(),
    path: text("virtual_path").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    revisionId: uuid("revision_id"),
    state: text("state")
      .$type<"live" | "trashed" | "deleted" | "unknown">()
      .notNull()
      .default("live"),
    firstObservedAt: time("first_observed_at").notNull().defaultNow(),
    lastConfirmedAt: time("last_confirmed_at").notNull().defaultNow(),
    fingerprint: text("fingerprint"),
  },
  (t) => [
    unique("activity_files_identity_id_unique").on(t.identityId, t.id),
    uniqueIndex("activity_files_live_path")
      .on(t.identityId, t.path)
      .where(sql`${t.state} = 'live'`),
  ],
);

export const activityFileBridges = appSchema.table(
  "activity_file_bridges",
  {
    identityId: uuid("identity_id").notNull(),
    namespace: text("namespace").notNull(),
    externalId: text("external_id").notNull(),
    fileId: uuid("file_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.identityId, t.namespace, t.externalId] }),
    foreignKey({
      columns: [t.identityId, t.fileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    index("activity_bridges_file").on(t.fileId),
    index("activity_bridges_file_fk").on(t.identityId, t.fileId),
  ],
);

export const activityFileLocations = appSchema.table(
  "activity_file_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    path: text("virtual_path").notNull(),
    validFrom: time("valid_from").notNull(),
    validUntil: time("valid_until"),
    generation: bigint("generation", { mode: "number" }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.identityId, t.fileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    index("activity_locations_file").on(t.fileId, t.validFrom),
    index("activity_locations_file_fk").on(t.identityId, t.fileId),
  ],
);

export const activityOperations = appSchema.table(
  "activity_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerAccountId: owner(),
    actorAccountId: uuid("actor_account_id").notNull(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => activityStorageIdentities.identityId),
    action: text("action").$type<PersonalActivityAction>().notNull(),
    source: text("source").$type<PersonalActivitySource>().notNull(),
    requestDigest: text("request_digest").notNull(),
    producerOperationId: text("producer_operation_id").notNull(),
    batchId: uuid("batch_id"),
    parentOperationId: uuid("parent_operation_id"),
    fileId: uuid("file_id"),
    fileGeneration: bigint("file_generation", { mode: "number" }),
    revisionId: uuid("revision_id"),
    state: text("state")
      .$type<"prepared" | "running" | "completed" | "failed" | "cancelled" | "uncertain">()
      .notNull(),
    before: jsonb("before").$type<ActivityFacts>(),
    requested: jsonb("requested").$type<ActivityFacts>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    finalEventId: uuid("final_event_id"),
  },
  (t) => [
    unique("activity_operations_dedupe").on(
      t.ownerAccountId,
      t.identityId,
      t.source,
      t.producerOperationId,
    ),
    index("activity_operations_recovery").on(t.state, t.updatedAt),
    index("activity_operations_identity").on(t.identityId),
    check("activity_operations_actor", sql`${t.ownerAccountId} = ${t.actorAccountId}`),
  ],
);

export const activityStreams = appSchema.table("activity_streams", {
  ownerAccountId: owner().primaryKey(),
  nextSequence: bigint("next_sequence", { mode: "number" }).notNull().default(1),
  retainedFrom: time("retained_from"),
  historyStartsAt: time("history_starts_at").notNull().defaultNow(),
});

export const activityEvents = appSchema.table(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerAccountId: owner(),
    ownerSequence: bigint("owner_sequence", { mode: "number" }).notNull(),
    actorAccountId: uuid("actor_account_id"),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => activityStorageIdentities.identityId),
    fileId: uuid("file_id"),
    class: text("class").$type<"action" | "observation">().notNull(),
    action: text("action").$type<PersonalActivityAction>().notNull(),
    stage: text("stage").$type<"intent" | "outcome" | "reconciliation">().notNull(),
    outcome: text("outcome").$type<PersonalActivityOutcome>(),
    source: text("source").$type<PersonalActivitySource>().notNull(),
    evidence: text("evidence").$type<PersonalActivityEvidence>().notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    operationId: uuid("operation_id"),
    producerOperationId: text("producer_operation_id"),
    batchId: uuid("batch_id"),
    parentEventId: uuid("parent_event_id"),
    occurredAt: time("occurred_at"),
    recordedAt: time("recorded_at").notNull().defaultNow(),
    sortAt: time("sort_at").notNull(),
    lastConfirmedAt: time("last_confirmed_at"),
    detectedAt: time("detected_at"),
    before: jsonb("before").$type<ActivityFacts>(),
    after: jsonb("after").$type<ActivityFacts>(),
    detail: jsonb("detail").$type<ActivityFacts>(),
    errorCode: text("safe_error_code"),
    count: integer("count").notNull().default(1),
    firstAt: time("first_at"),
    lastAt: time("last_at"),
    outcomeCounts:
      jsonb("outcome_counts").$type<Partial<Record<PersonalActivityOutcome, number>>>(),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (t) => [
    unique("activity_events_owner_id").on(t.ownerAccountId, t.id),
    unique("activity_events_owner_sequence").on(t.ownerAccountId, t.ownerSequence),
    unique("activity_events_dedupe").on(t.ownerAccountId, t.identityId, t.idempotencyKey),
    index("activity_events_feed").on(t.ownerAccountId, t.sortAt.desc(), t.id.desc()),
    index("activity_events_location").on(
      t.ownerAccountId,
      t.identityId,
      t.sortAt.desc(),
      t.id.desc(),
    ),
    index("activity_events_file").on(t.ownerAccountId, t.fileId, t.sortAt.desc(), t.id.desc()),
    index("activity_events_batch").on(t.ownerAccountId, t.batchId, t.sortAt.desc(), t.id.desc()),
    index("activity_events_identity").on(t.identityId),
    check(
      "activity_events_actor",
      sql`(${t.class} = 'action' and ${t.actorAccountId} = ${t.ownerAccountId}) or (${t.class} = 'observation' and ${t.actorAccountId} is null)`,
    ),
    check(
      "activity_events_actor_required",
      sql`${t.class} <> 'action' or ${t.actorAccountId} is not null`,
    ),
    check(
      "activity_events_payload_budget",
      sql`octet_length(coalesce(${t.before}::text,'') || coalesce(${t.after}::text,'') || coalesce(${t.detail}::text,'')) <= 16384`,
    ),
  ],
);

export const activityEventSubjects = appSchema.table(
  "activity_event_subjects",
  {
    ownerAccountId: owner(),
    eventId: uuid("event_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    fileId: uuid("file_id"),
    role: text("role").$type<"primary" | "source" | "target" | "affected">().notNull(),
    ordinal: integer("subject_ordinal").notNull(),
    path: text("virtual_path_snapshot"),
    revisionId: uuid("revision_id"),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.identityId, t.role, t.ordinal] }),
    foreignKey({
      columns: [t.ownerAccountId, t.eventId],
      foreignColumns: [activityEvents.ownerAccountId, activityEvents.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.identityId, t.fileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    index("activity_subjects_file").on(t.ownerAccountId, t.fileId, t.eventId),
    index("activity_subjects_path").on(t.ownerAccountId, t.path),
    index("activity_subjects_path_search").using("gin", t.path.op("gin_trgm_ops")),
    index("activity_subjects_event_page").on(t.ownerAccountId, t.eventId, t.ordinal),
    index("activity_subjects_file_fk").on(t.identityId, t.fileId),
  ],
);
export const activityRevisions = appSchema.table(
  "activity_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    ownerAccountId: owner(),
    eventId: uuid("event_id").notNull(),
    providerVersion: text("provider_version"),
    sha256: text("sha256"),
    size: bigint("size", { mode: "number" }),
    previousRevisionId: uuid("previous_revision_id"),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerAccountId, t.eventId],
      foreignColumns: [activityEvents.ownerAccountId, activityEvents.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.identityId, t.fileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    index("activity_revisions_file").on(t.ownerAccountId, t.fileId),
    index("activity_revisions_event").on(t.ownerAccountId, t.eventId),
    index("activity_revisions_file_fk").on(t.identityId, t.fileId),
  ],
);
export const activityLineage = appSchema.table(
  "activity_lineage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerAccountId: owner(),
    eventId: uuid("event_id").notNull(),
    sourceFileId: uuid("source_file_id").notNull(),
    sourceIdentityId: uuid("source_identity_id").notNull(),
    targetFileId: uuid("target_file_id").notNull(),
    targetIdentityId: uuid("target_identity_id").notNull(),
    kind: text("kind").$type<"copy" | "save_as" | "archive_member" | "derived">().notNull(),
    evidence: text("evidence").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerAccountId, t.eventId],
      foreignColumns: [activityEvents.ownerAccountId, activityEvents.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.sourceIdentityId, t.sourceFileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    foreignKey({
      columns: [t.targetIdentityId, t.targetFileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    index("activity_lineage_source").on(t.ownerAccountId, t.sourceFileId),
    index("activity_lineage_target").on(t.ownerAccountId, t.targetFileId),
    index("activity_lineage_event").on(t.ownerAccountId, t.eventId),
    index("activity_lineage_source_fk").on(t.sourceIdentityId, t.sourceFileId),
    index("activity_lineage_target_fk").on(t.targetIdentityId, t.targetFileId),
  ],
);
export const activityTrashBindings = appSchema.table(
  "activity_trash_bindings",
  {
    fileId: uuid("file_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    ownerAccountId: owner(),
    eventId: uuid("event_id").notNull(),
    strategy: text("strategy").$type<"sftpgo_rule" | "fdrive_move">().notNull(),
    originalPath: text("original_virtual_path").notNull(),
    trashLeaf: text("trash_virtual_leaf"),
    state: text("state").$type<"bound" | "unresolved" | "restored" | "purged">().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.fileId] }),
    foreignKey({
      columns: [t.ownerAccountId, t.eventId],
      foreignColumns: [activityEvents.ownerAccountId, activityEvents.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.identityId, t.fileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    index("activity_trash_leaf").on(t.identityId, t.trashLeaf),
    index("activity_trash_event").on(t.ownerAccountId, t.eventId),
    index("activity_trash_file_fk").on(t.identityId, t.fileId),
  ],
);

export const activityReadWindows = appSchema.table(
  "activity_read_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerAccountId: owner(),
    identityId: uuid("identity_id").notNull(),
    fileId: uuid("file_id").notNull(),
    action: text("action").$type<PersonalActivityAction>().notNull(),
    source: text("source").$type<PersonalActivitySource>().notNull(),
    contextHash: text("context_hash").notNull(),
    evidence: text("evidence").$type<PersonalActivityEvidence>().notNull(),
    generation: bigint("file_generation", { mode: "number" }).notNull(),
    bucketStart: time("bucket_start").notNull(),
    path: text("virtual_path").notNull(),
    firstAt: time("first_at").notNull(),
    lastAt: time("last_at").notNull(),
    count: integer("attempted_count").notNull(),
    outcomeCounts: jsonb("outcome_counts")
      .$type<Partial<Record<PersonalActivityOutcome, number>>>()
      .notNull(),
    sealedAt: time("sealed_at"),
  },
  (t) => [
    unique("activity_read_window_key").on(
      t.ownerAccountId,
      t.identityId,
      t.fileId,
      t.action,
      t.source,
      t.contextHash,
      t.generation,
      t.bucketStart,
    ),
    foreignKey({
      columns: [t.identityId, t.fileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    index("activity_read_windows_seal").on(t.sealedAt, t.bucketStart),
    index("activity_read_windows_file_fk").on(t.identityId, t.fileId),
  ],
);
export const activityReadReceipts = appSchema.table(
  "activity_read_receipts",
  {
    ownerAccountId: owner(),
    identityId: uuid("identity_id").notNull(),
    contextHash: text("context_hash").notNull(),
    requestId: uuid("request_id").notNull(),
    windowId: uuid("window_id")
      .notNull()
      .references(() => activityReadWindows.id),
    outcome: text("outcome").$type<PersonalActivityOutcome>(),
    expiresAt: time("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerAccountId, t.identityId, t.contextHash, t.requestId] }),
    index("activity_read_receipts_expiry").on(t.expiresAt),
    index("activity_read_receipts_window").on(t.windowId),
  ],
);
export const activityObservationState = appSchema.table(
  "activity_observation_state",
  {
    ownerAccountId: owner(),
    identityId: uuid("identity_id").notNull(),
    fileId: uuid("file_id").notNull(),
    generation: bigint("prior_generation", { mode: "number" }).notNull(),
    discrepancy: text("discrepancy").notNull(),
    fingerprint: text("evidence_fingerprint").notNull(),
    eventId: uuid("event_id"),
    resolvedEventId: uuid("resolved_event_id"),
    lastCheckAt: time("last_check_at").notNull(),
    lastConfirmedAt: time("last_confirmed_at"),
    detectedAt: time("detected_at"),
    checkError: text("check_error"),
  },
  (t) => [
    primaryKey({
      columns: [t.ownerAccountId, t.identityId, t.fileId, t.generation, t.discrepancy],
    }),
    foreignKey({
      columns: [t.identityId, t.fileId],
      foreignColumns: [activityFiles.identityId, activityFiles.id],
    }),
    index("activity_observation_file_fk").on(t.identityId, t.fileId),
  ],
);
export const activityOutbox = appSchema.table(
  "activity_outbox",
  {
    eventId: uuid("event_id").primaryKey(),
    ownerAccountId: owner(),
    ownerSequence: bigint("owner_sequence", { mode: "number" }).notNull(),
    availableAt: time("available_at").notNull().defaultNow(),
    deliveredAt: time("delivered_at"),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerAccountId, t.eventId],
      foreignColumns: [activityEvents.ownerAccountId, activityEvents.id],
    }).onDelete("cascade"),
    index("activity_outbox_pending").on(t.deliveredAt, t.availableAt),
    index("activity_outbox_owner_sequence").on(t.ownerAccountId, t.ownerSequence),
    index("activity_outbox_event").on(t.ownerAccountId, t.eventId),
  ],
);
export const activityExports = appSchema.table(
  "activity_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerAccountId: owner(),
    format: text("format").$type<"json" | "csv">().notNull(),
    state: text("state")
      .$type<"queued" | "running" | "completed" | "failed">()
      .notNull()
      .default("queued"),
    filters: jsonb("filters").$type<Record<string, string>>().notNull(),
    snapshotSequence: bigint("snapshot_sequence", { mode: "number" }).notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    expiresAt: time("expires_at").notNull(),
    rowCount: bigint("row_count", { mode: "number" }).notNull().default(0),
    errorCode: text("safe_error_code"),
  },
  (t) => [index("activity_exports_owner").on(t.ownerAccountId, t.createdAt)],
);

/** Export freezes open read windows without sealing or changing their collapse behavior. */
export type ActivityReadSnapshot = Omit<
  typeof activityReadWindows.$inferSelect,
  "bucketStart" | "firstAt" | "lastAt" | "sealedAt"
> & { bucketStart: string; firstAt: string; lastAt: string; sealedAt: null };
export const activityExportReads = appSchema.table(
  "activity_export_reads",
  {
    exportId: uuid("export_id")
      .notNull()
      .references(() => activityExports.id, { onDelete: "cascade" }),
    ownerAccountId: owner(),
    windowId: uuid("window_id").notNull(),
    payload: jsonb("payload").$type<ActivityReadSnapshot>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerAccountId, t.exportId, t.windowId] }),
    index("activity_export_reads_export").on(t.exportId),
  ],
);
