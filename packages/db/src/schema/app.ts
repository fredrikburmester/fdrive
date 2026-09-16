import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DesktopEffectPayload } from "../repos/desktop-effects-types.js";
import type { ApiTokenAccess } from "../repos/types.js";
import { vector } from "../vector.js";

/**
 * bytea maps to a Node Buffer on both read and write, matching what the
 * node-postgres driver already returns for a bytea column.
 */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const appSchema = pgSchema("app");

export const providers = appSchema.table(
  "providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    baseUrl: text("base_url").notNull(),
    /** Shown to users on the login page and in the login switcher. Defaults to the endpoint host. */
    label: text("label").notNull().default(""),
    /** The provider module's `configFields` values (for SFTPGo: `homeTemplate`). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    /** True when the endpoint is pinned by environment (`SFTPGO_URL`) and cannot change at runtime. */
    managedByEnv: boolean("managed_by_env").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("providers_type_base_url_unique").on(table.type, table.baseUrl)],
);

export const accounts = appSchema.table("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  isAdmin: boolean("is_admin").notNull().default(false),
});

export const identities = appSchema.table(
  "identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    externalUsername: text("external_username").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    unique("identities_provider_id_external_username_unique").on(
      table.providerId,
      table.externalUsername,
    ),
    index("identities_account_id_idx").on(table.accountId),
  ],
);

export const credentials = appSchema.table("credentials", {
  identityId: uuid("identity_id")
    .primaryKey()
    .references(() => identities.id, { onDelete: "cascade" }),
  ciphertext: bytea("ciphertext").notNull(),
  keyId: text("key_id").notNull(),
  cachedToken: text("cached_token"),
  cachedTokenExpiresAt: timestamp("cached_token_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = appSchema.table(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    activeIdentityId: uuid("active_identity_id").references(() => identities.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (table) => [
    index("sessions_expires_at_idx").on(table.expiresAt),
    index("sessions_account_id_idx").on(table.accountId),
    index("sessions_active_identity_id_idx").on(table.activeIdentityId),
  ],
);

export const apiTokens = appSchema.table(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    identityId: uuid("identity_id").references(() => identities.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    access: jsonb("access").$type<ApiTokenAccess>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("api_tokens_account_id_idx").on(table.accountId),
    index("api_tokens_identity_id_idx").on(table.identityId),
  ],
);

export const tags = appSchema.table(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
  },
  (table) => [unique("tags_account_id_name_unique").on(table.accountId, table.name)],
);

export const fileTags = appSchema.table(
  "file_tags",
  {
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    revision: uuid("revision").notNull().defaultRandom(),
  },
  (table) => [
    primaryKey({ columns: [table.identityId, table.path, table.tagId] }),
    index("file_tags_tag_id_idx").on(table.tagId),
  ],
);

export const favorites = appSchema.table(
  "favorites",
  {
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** "file" or "dir": what kind of entry was favorited, since the fs entry itself is not looked up again for display. */
    kind: text("kind").notNull().default("file"),
    revision: uuid("revision").notNull().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.identityId, table.path] })],
);

/** Per-identity view pins for real directories. */
export const folderViews = appSchema.table(
  "folder_views",
  {
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** Null when only the sort is pinned. */
    mode: text("mode"),
    revision: uuid("revision").notNull().defaultRandom(),
    sort: jsonb("sort"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.identityId, table.path] })],
);

export const recents = appSchema.table(
  "recents",
  {
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    revision: uuid("revision").notNull().defaultRandom(),
  },
  (table) => [
    primaryKey({ columns: [table.identityId, table.path] }),
    index("recents_identity_id_opened_at_idx").on(table.identityId, table.openedAt.desc()),
  ],
);

export const thumbnails = appSchema.table(
  "thumbnails",
  {
    contentKey: text("content_key").notNull(),
    size: integer("size").notNull(),
    storagePath: text("storage_path").notNull(),
    width: integer("width"),
    height: integer("height"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.contentKey, table.size] })],
);

/**
 * One SigLIP embedding of a 256 px thumbnail, keyed by the same
 * `content_key` (sha256) `thumbnails` uses so two copies of one photo are
 * embedded once. `model` records which sidecar model produced the vector;
 * search filters to a single model and the rebuild pass replaces rows a
 * different model wrote. Index declarations mirror the migration-owned indexes.
 */
export const imageEmbeddings = appSchema.table(
  "image_embeddings",
  {
    contentKey: text("content_key").primaryKey(),
    model: text("model").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("image_embeddings_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const wopiLocks = appSchema.table(
  "wopi_locks",
  {
    fileId: text("file_id").primaryKey(),
    lockId: text("lock_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("wopi_locks_expires_at_idx").on(table.expiresAt)],
);

export const shares = appSchema.table(
  "shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    sftpgoShareId: text("sftpgo_share_id").notNull(),
    name: text("name").notNull(),
    scope: text("scope").notNull(),
    paths: text("paths").array().notNull(),
    hasPassword: boolean("has_password").notNull().default(false),
    /** Operator-chosen public page rendering: "auto" | "list" | "gallery" | "download". */
    presentation: text("presentation").notNull().default("auto"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Legacy name: cached SFTPGo used_tokens (transfers), exposed as usedDownloads. */
    views: integer("views").notNull().default(0),
  },
  (table) => [
    unique("shares_identity_id_sftpgo_share_id_unique").on(table.identityId, table.sftpgoShareId),
  ],
);

export const settings = appSchema.table("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Shared office identity survives index clears and user-specific scopes.
 * Rows go with their provider: once a provider row is removed (which
 * requires that no login uses it) nothing can open the documents it named.
 */
export const officeFiles = appSchema.table(
  "office_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    rootName: text("root_name").notNull(),
    path: text("path").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    revision: uuid("revision").notNull().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("office_files_provider_id_idx").on(table.providerId),
    uniqueIndex("office_files_active_location_unique")
      .on(table.providerId, table.rootName, table.path)
      .where(sql`${table.deletedAt} is null`),
  ],
);

/**
 * The admin-facing event log: one row per notable subsystem event the API
 * records (a settings change, a maintenance action, a sidecar failure).
 * Written only by the API; reads merge it with the sidecars' own history
 * (`idx.scans`, `idx.files`, `idx.ocr_runs`, `idx.ocr_log`) so an admin
 * sees one stream per subsystem. Retention is per subsystem, pruned
 * opportunistically rather than by a scheduled job.
 */
export const systemEvents = appSchema.table(
  "system_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    subsystem: text("subsystem").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    data: jsonb("data"),
  },
  (table) => [
    index("system_events_subsystem_at_idx").on(table.subsystem, table.at.desc(), table.id.desc()),
  ],
);

/** Lazily registered desktop items; paths never act as authorization. */
export const desktopItems = appSchema.table(
  "desktop_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    metadataVersion: uuid("metadata_version").notNull().defaultRandom(),
    contentVersion: text("content_version"),
    originalPath: text("original_path"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("desktop_items_live_path")
      .on(table.identityId, table.path)
      .where(sql`${table.deletedAt} is null`),
    index("desktop_items_identity").on(table.identityId),
  ],
);

/** Immutable request identity plus durable mutation/recovery state. */
export const desktopOperations = appSchema.table(
  "desktop_operations",
  {
    id: uuid("id").notNull(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    requestHash: text("request_hash").notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.identityId, table.id] }),
    index("desktop_operations_account").on(table.accountId),
    index("desktop_operations_cleanup").on(table.state, table.updatedAt),
  ],
);

/** Metadata work is committed with the native receipt, never with a file replay. */
export const desktopEffects = appSchema.table(
  "desktop_effects",
  {
    sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
    operationId: uuid("operation_id").notNull(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<DesktopEffectPayload>().notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("desktop_effects_operation").on(table.identityId, table.operationId),
    foreignKey({
      columns: [table.identityId, table.operationId],
      foreignColumns: [desktopOperations.identityId, desktopOperations.id],
    }).onDelete("cascade"),
    index("desktop_effects_pending")
      .on(table.nextAttemptAt, table.sequence)
      .where(sql`${table.state} = 'pending'`),
    index("desktop_effects_identity_pending")
      .on(table.identityId, table.sequence)
      .where(sql`${table.state} = 'pending'`),
    index("desktop_effects_account").on(table.accountId),
  ],
);

/** Installation backup configuration. Private keys are never persisted here. */
export const backupConfiguration = appSchema.table("backup_configuration", {
  id: integer("id").primaryKey().default(1),
  installationId: uuid("installation_id").notNull().defaultRandom(),
  recipient: text("recipient"),
  confirmed: boolean("confirmed").notNull().default(false),
  challengeHash: text("challenge_hash"),
  challengeExpiresAt: timestamp("challenge_expires_at", { withTimezone: true }),
  schedule: jsonb("schedule")
    .notNull()
    .default({ frequency: "manual", timezone: "UTC", hour: 3, daily: 7, weekly: 4, monthly: 12 }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  restored: boolean("restored").notNull().default(false),
});
export const backupDestinations = appSchema.table("backup_destinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  revision: uuid("revision").notNull().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  config: jsonb("config").notNull(),
  secret: bytea("secret").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  testedAt: timestamp("tested_at", { withTimezone: true }),
});
export const backupRuns = appSchema.table(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").notNull().default("queued"),
    leaseId: uuid("lease_id"),
    verificationRequested: boolean("verification_requested").notNull().default(false),
    verificationError: text("verification_error"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    requestedBy: uuid("requested_by"),
    scheduleSlot: text("schedule_slot").unique(),
    request: jsonb("request").notNull(),
    recipient: text("recipient").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    bytes: text("bytes").notNull().default("0"),
    sha256: text("sha256"),
    error: text("error"),
    coverage: jsonb("coverage").notNull().default([]),
    pinned: boolean("pinned").notNull().default(false),
    artifact: text("artifact"),
  },
  (table) => [index("backup_runs_created_idx").on(table.createdAt)],
);
export const backupDeliveries = appSchema.table(
  "backup_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => backupRuns.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id").notNull(),
    destinationRevision: uuid("destination_revision").notNull(),
    name: text("name").notNull(),
    state: text("state").notNull().default("pending"),
    objectKey: text("object_key"),
    markerVersionId: text("marker_version_id"),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    versionId: text("version_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    index("backup_deliveries_run_idx").on(table.runId),
    unique("backup_delivery_run_destination").on(table.runId, table.destinationId),
  ],
);
export const backupAttachments = appSchema.table("backup_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id").notNull(),
  label: text("label").notNull(),
  filename: text("filename").notNull(),
  sourceDate: timestamp("source_date", { withTimezone: true }),
  notes: text("notes").notNull().default(""),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  bytes: text("bytes").notNull(),
  sha256: text("sha256").notNull(),
  secret: bytea("secret").notNull(),
});
