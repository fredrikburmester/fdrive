import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("providers_type_base_url_unique").on(table.type, table.baseUrl)],
);

export const accounts = appSchema.table("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  (table) => [index("sessions_expires_at_idx").on(table.expiresAt)],
);

export const apiTokens = appSchema.table("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  identityId: uuid("identity_id").references(() => identities.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

export const wopiLocks = appSchema.table("wopi_locks", {
  fileId: text("file_id").primaryKey(),
  lockId: text("lock_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

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
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
