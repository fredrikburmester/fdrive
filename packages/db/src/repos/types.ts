/** A storage backend instance: one SFTPGo server, one WebDAV endpoint, one bucket. */
export interface Provider {
  readonly id: string;
  readonly type: string;
  readonly baseUrl: string;
  /** Shown to users; empty means "use the endpoint host". */
  readonly label: string;
  /** The provider module's configuration values, validated by the module. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  /** The endpoint is pinned by environment and cannot be changed at runtime. */
  readonly managedByEnv: boolean;
  readonly createdAt: Date;
}

export interface ProviderPatch {
  readonly label?: string;
  readonly baseUrl?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly enabled?: boolean;
  readonly managedByEnv?: boolean;
}

export interface ProviderRepo {
  get(id: string): Promise<Provider | null>;
  /** Every provider, oldest first. */
  list(): Promise<Provider[]>;
  /**
   * Finds the provider for (type, baseUrl), creating it when it does not
   * exist yet. Idempotent: repeated calls with the same input always
   * return the same row, and never change an existing row's other fields.
   */
  ensure(input: { type: string; baseUrl: string }): Promise<Provider>;
  /** Atomic insert-only creation; duplicate endpoint throws ConflictError. */
  create(input: { type: string; baseUrl: string } & ProviderPatch): Promise<Provider>;
  /** Applies `patch` and returns the row, or `null` when no such provider exists. */
  update(id: string, patch: ProviderPatch): Promise<Provider | null>;
  /**
   * Deletes the provider. Throws `ConflictError` while identities still
   * reference it; a no-op when it does not exist.
   */
  delete(id: string): Promise<void>;
}

/** An fdrive user, created on first successful login. */
export interface Account {
  readonly id: string;
  readonly displayName: string | null;
  readonly createdAt: Date;
  readonly isAdmin: boolean;
}

export interface AccountRepo {
  create(input: { displayName: string | null }): Promise<Account>;
  get(id: string): Promise<Account | null>;
  /** Sets the account's admin flag. A no-op when the account does not exist. */
  setAdmin(id: string, isAdmin: boolean): Promise<void>;
}

/** A login on a provider. Belongs to exactly one account. */
export interface Identity {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly externalUsername: string;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
}

export interface IdentityRepo {
  findByProviderUsername(providerId: string, username: string): Promise<Identity | null>;
  create(input: {
    accountId: string;
    providerId: string;
    externalUsername: string;
  }): Promise<Identity>;
  get(id: string): Promise<Identity | null>;
  listByAccount(accountId: string): Promise<Identity[]>;
  touchLogin(id: string, at: Date): Promise<void>;
  /** How many identities reference `providerId`. */
  countByProvider(providerId: string): Promise<number>;
  /**
   * Every identity across every account. Used by the indexer event listener
   * to resolve which identities a filesystem change under a given root and
   * path is visible to, since a change is not scoped to one account ahead of
   * time the way a request is.
   */
  listAll(): Promise<Identity[]>;
}

/**
 * The envelope-encrypted SFTPGo password for one identity, plus the
 * currently cached (also sealed) SFTPGo JWT and its expiry, when one has
 * been minted.
 */
export interface Credential {
  readonly identityId: string;
  readonly ciphertext: Uint8Array;
  readonly keyId: string;
  readonly cachedToken: string | null;
  readonly cachedTokenExpiresAt: Date | null;
  readonly updatedAt: Date;
}

export interface CredentialRepo {
  put(input: { identityId: string; ciphertext: Uint8Array; keyId: string }): Promise<void>;
  get(identityId: string): Promise<Credential | null>;
  setCachedToken(
    identityId: string,
    token: { sealed: string; expiresAt: Date } | null,
  ): Promise<void>;
}

/** An opaque server-side session. The cookie carries the raw id; only its hash is stored. */
export interface Session {
  readonly idHash: string;
  readonly accountId: string;
  readonly activeIdentityId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface SessionRepo {
  create(input: {
    idHash: string;
    accountId: string;
    activeIdentityId: string | null;
    expiresAt: Date;
    userAgent: string | null;
    ip: string | null;
  }): Promise<Session>;
  /** Returns null both when the session does not exist and when it has expired as of `now`. */
  getByIdHash(idHash: string, now: Date): Promise<Session | null>;
  touch(idHash: string, input: { lastSeenAt: Date; expiresAt: Date }): Promise<void>;
  delete(idHash: string): Promise<void>;
  /** Deletes every session whose expiry is at or before `now`. Returns the number deleted. */
  deleteExpired(now: Date): Promise<number>;
}

/**
 * Key/value settings storage over `app.settings`. Values are stored as
 * JSON; callers are responsible for the shape at a given key.
 */
export interface SettingsRepo {
  /** Returns the value stored at `key`, or null when no row exists. */
  get<T>(key: string): Promise<T | null>;
  /** Upserts the value stored at `key`. */
  set(key: string, value: unknown): Promise<void>;
  /**
   * Atomically replaces a setting only when its current value is `expected`.
   * Pass `null` to create a previously absent key. JSON values are compared
   * structurally by the database, so this is safe for cross-process claims.
   */
  compareAndSet(key: string, expected: unknown | null, value: unknown): Promise<boolean>;
  /** Returns every setting as a plain object keyed by its setting key. */
  all(): Promise<Record<string, unknown>>;
}

/**
 * A long-lived per-account (optionally per-identity) token for MCP and
 * Raycast, shown once at creation and stored only as a sha256 hash.
 */
export interface ApiTokenAccess {
  readonly mode: "read" | "organize" | "full";
  readonly paths: string[];
}

export interface ApiToken {
  readonly id: string;
  readonly accountId: string;
  /** The identity the token is scoped to. `null` after that identity is unlinked; such a token can no longer authenticate. */
  readonly identityId: string | null;
  readonly name: string;
  readonly tokenHash: string;
  readonly access?: ApiTokenAccess;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
}

export interface ApiTokenRepo {
  create(input: {
    accountId: string;
    identityId: string | null;
    name: string;
    tokenHash: string;
    access?: ApiTokenAccess;
    expiresAt: Date | null;
  }): Promise<ApiToken>;
  /** Looks up a token by its sha256 hash. `null` when no token has that hash, expired or not. */
  findByHash(hash: string): Promise<ApiToken | null>;
  listByAccount(accountId: string): Promise<ApiToken[]>;
  /** Sets `lastUsedAt`. A no-op when the token does not exist. */
  touch(id: string, at: Date): Promise<void>;
  /** Deletes the token, scoped to `accountId` so one account can never revoke another's token. */
  delete(id: string, accountId: string): Promise<void>;
}

/**
 * Thrown by `TagRepo.create`/`.update` when the requested name already
 * exists for that account (`app.tags` is unique on `(account_id, name)`).
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** A tag an account can attach to files and folders across every identity's paths. */
export interface Tag {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly color: string | null;
}

export interface TagRepo {
  list(accountId: string): Promise<Tag[]>;
  /** Throws `ConflictError` when `input.name` already exists for `accountId`. */
  create(accountId: string, input: { name: string; color: string | null }): Promise<Tag>;
  /**
   * Updates the tag, scoped to `accountId` so one account can never edit
   * another's tag. `null` when no such tag exists for that account. Throws
   * `ConflictError` when `patch.name` collides with a different existing tag.
   */
  update(
    id: string,
    accountId: string,
    patch: { name?: string; color?: string | null },
  ): Promise<Tag | null>;
  /** Deletes the tag (cascading to `file_tags`), scoped to `accountId`. A no-op when not found. */
  delete(id: string, accountId: string): Promise<void>;
}

/** One (identity, path, tag) assignment. */
export interface FileTagRepo {
  /** The tag ids assigned to each of `paths`, keyed by path. Paths with no tags are omitted. */
  tagsForPaths(identityId: string, paths: readonly string[]): Promise<Map<string, string[]>>;
  /** Replaces the full set of tags assigned to `path` with exactly `tagIds`. */
  setTags(identityId: string, path: string, tagIds: readonly string[]): Promise<void>;
  /** Every path tagged with `tagId` for `identityId`. */
  pathsForTag(identityId: string, tagId: string): Promise<string[]>;
  /**
   * Rewrites `oldPath` to `newPath` for `identityId`: the exact path always,
   * plus (when `isDir`) every row nested under it. A row already present at
   * a computed destination is replaced.
   */
  movePrefix(identityId: string, oldPath: string, newPath: string, isDir: boolean): Promise<void>;
  /** Deletes `path` (and, when `isDir`, everything nested under it) for `identityId`. */
  deletePrefix(identityId: string, path: string, isDir: boolean): Promise<void>;
}

/** The kind of entry a favorite points at, since it is not looked up again to render the list. */
export type FavoriteKind = "file" | "dir";

export interface Favorite {
  readonly identityId: string;
  readonly path: string;
  readonly kind: FavoriteKind;
  readonly createdAt: Date;
}

export interface FavoriteRepo {
  list(identityId: string): Promise<Favorite[]>;
  /** Idempotent: favoriting an already-favorited path updates its `kind`. */
  add(identityId: string, path: string, kind: FavoriteKind): Promise<void>;
  /** A no-op when `path` is not favorited. */
  remove(identityId: string, path: string): Promise<void>;
  /** The subset of `paths` that are favorited for `identityId`. */
  has(identityId: string, paths: readonly string[]): Promise<Set<string>>;
  movePrefix(identityId: string, oldPath: string, newPath: string, isDir: boolean): Promise<void>;
  deletePrefix(identityId: string, path: string, isDir: boolean): Promise<void>;
}

export type FolderViewMode = "list" | "grid" | "tree";
export type FolderViewSortKey = "name" | "size" | "modifiedAt" | "ext";
export type FolderViewSortDirection = "asc" | "desc";
export interface FolderViewSort {
  readonly key: FolderViewSortKey;
  readonly direction: FolderViewSortDirection;
}
export interface FolderView {
  readonly identityId: string;
  readonly path: string;
  /** Null when only the sort is pinned. */
  readonly mode: FolderViewMode | null;
  readonly sort: FolderViewSort | null;
  readonly updatedAt: Date;
}
/** Fields to change on a pin: `undefined` keeps the stored value, `null` clears it. */
export interface FolderViewPatch {
  readonly mode?: FolderViewMode | null;
  readonly sort?: FolderViewSort | null;
}
export interface FolderViewRepo {
  get(identityId: string, path: string): Promise<FolderView | null>;
  /**
   * Upserts the pin at `path`, merging `patch` over the stored fields. A pin
   * left with neither a mode nor a sort is removed; an empty patch is a no-op.
   */
  set(identityId: string, path: string, patch: FolderViewPatch): Promise<void>;
  /** A no-op when `path` is not pinned. */
  remove(identityId: string, path: string): Promise<void>;
  /** Removes every pin for one identity. */
  clear(identityId: string): Promise<void>;
  /** Whether the exact path is pinned for this identity. */
  has(identityId: string, path: string): Promise<boolean>;
  movePrefix(identityId: string, oldPath: string, newPath: string, isDir: boolean): Promise<void>;
  deletePrefix(identityId: string, path: string, isDir: boolean): Promise<void>;
}

export interface Recent {
  readonly identityId: string;
  readonly path: string;
  readonly openedAt: Date;
}

export interface RecentRepo {
  /** The most recently opened paths for `identityId`, most recent first. */
  list(identityId: string, limit: number): Promise<Recent[]>;
  /** Records `path` as opened now (or updates its `openedAt` when already recorded). */
  touch(identityId: string, path: string): Promise<void>;
  movePrefix(identityId: string, oldPath: string, newPath: string, isDir: boolean): Promise<void>;
  deletePrefix(identityId: string, path: string, isDir: boolean): Promise<void>;
  /** Deletes every row for `identityId` beyond the `keep` most recently opened. */
  prune(identityId: string, keep: number): Promise<void>;
}

/**
 * Coordinates path changes across every metadata table. Implementations must
 * apply each operation atomically: callers either observe all metadata moved
 * or deleted, or none of it.
 */
export interface MetadataPathRepo {
  movePrefix(identityId: string, oldPath: string, newPath: string, isDir: boolean): Promise<void>;
  deletePrefix(identityId: string, path: string, isDir: boolean): Promise<void>;
}

/** What one AI chat shares with the model; mirrors the contracts' `OrganizeSharing`. */
export interface AiChatSharing {
  readonly contents: boolean;
  readonly otherFileNames: boolean;
}

export type AiChatRole = "user" | "assistant";

export interface AiChat {
  readonly id: string;
  readonly identityId: string;
  readonly title: string;
  readonly share: AiChatSharing;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastMessageAt: Date;
}

export interface AiChatMessage {
  readonly id: string;
  readonly chatId: string;
  /** 1 for the first message; dense and unique within a chat. */
  readonly ordinal: number;
  readonly role: AiChatRole;
  /** Transcript parts as stored; the API validates them against its contracts. */
  readonly parts: readonly unknown[];
  readonly references: readonly string[];
  readonly location: string | null;
  readonly createdAt: Date;
}

export interface AiChatReference {
  readonly path: string;
  readonly missing: boolean;
  readonly addedAt: Date;
}

/**
 * AI chats, their transcripts and references. Every read and write that
 * names a chat is scoped to the identity that owns it, so one login can
 * never see or touch another's chats.
 */
export interface AiChatRepo {
  create(input: { identityId: string; title: string; share: AiChatSharing }): Promise<AiChat>;
  get(identityId: string, id: string): Promise<AiChat | null>;
  /** The identity's chats, most recent message first. */
  list(identityId: string, limit: number): Promise<AiChat[]>;
  rename(identityId: string, id: string, title: string): Promise<AiChat | null>;
  /** True when a chat was deleted. */
  delete(identityId: string, id: string): Promise<boolean>;
  /** Deletes the identity's chats idle since before `idleBefore`, then all but the `keep` most recent. Returns how many went. */
  prune(identityId: string, options: { keep: number; idleBefore: Date }): Promise<number>;
  /** The chat's messages in order. */
  messages(chatId: string): Promise<AiChatMessage[]>;
  /** Appends a message with the next ordinal and marks the chat as active now. */
  appendMessage(
    chatId: string,
    input: {
      role: AiChatRole;
      parts: readonly unknown[];
      references: readonly string[];
      location: string | null;
    },
  ): Promise<AiChatMessage>;
  updateMessageParts(messageId: string, parts: readonly unknown[]): Promise<void>;
  references(chatId: string): Promise<AiChatReference[]>;
  /** Adds paths, or clears `missing` on ones already referenced. */
  addReferences(chatId: string, paths: readonly string[]): Promise<void>;
  /** Follows a move or rename across every chat of the identity; a folder carries its contents. */
  moveReferences(
    identityId: string,
    oldPath: string,
    newPath: string,
    isDir: boolean,
  ): Promise<void>;
  /** Marks references at `path` (and inside it when a folder) missing across every chat of the identity. */
  markReferencesMissing(identityId: string, path: string, isDir: boolean): Promise<void>;
}

/** Severity of one `SystemEvent`, ordered `info` < `warn` < `error`. */
export type SystemEventLevel = "info" | "warn" | "error";

/**
 * Which store an event was read from: `api` for a row the API wrote to
 * `app.system_events`, `indexer` and `ocr` for history the sidecars keep in
 * their own tables and that reads merge in.
 */
export type SystemEventSource = "api" | "indexer" | "ocr";

/**
 * One entry in a subsystem's event log. `id` is prefixed by source
 * ("api:123", "scan:45") because the merged stream draws from several
 * tables whose numeric ids overlap.
 */
export interface SystemEvent {
  readonly id: string;
  readonly at: Date;
  readonly subsystem: string;
  readonly level: SystemEventLevel;
  readonly message: string;
  readonly data: unknown | null;
  readonly source: SystemEventSource;
}

export interface SystemEventListOptions {
  /** Maximum entries to return. */
  readonly limit: number;
  /** Minimum severity to include; defaults to `info` (everything). */
  readonly minLevel?: SystemEventLevel;
  /** Only entries strictly older than this instant, for paging backwards. */
  readonly before?: Date;
}

/** Severity order, lowest first. */
export const SYSTEM_EVENT_LEVELS = ["info", "warn", "error"] as const;

/**
 * The levels at or above `minLevel` (every level when it is omitted), the
 * filter both the Drizzle and the in-memory event log apply to a `list`.
 */
export function levelsAtLeast(minLevel: SystemEventLevel | undefined): SystemEventLevel[] {
  const from = SYSTEM_EVENT_LEVELS.indexOf(minLevel ?? "info");
  return SYSTEM_EVENT_LEVELS.slice(from === -1 ? 0 : from);
}

export interface SystemEventRepo {
  /** Appends one API-written event. */
  append(input: {
    subsystem: string;
    level: SystemEventLevel;
    message: string;
    data?: unknown;
  }): Promise<void>;
  /** One subsystem's entries, newest first, merged across every source. */
  list(subsystem: string, opts: SystemEventListOptions): Promise<SystemEvent[]>;
  /** Deletes every API-written row for `subsystem` beyond the `keep` newest. */
  prune(subsystem: string, keep: number): Promise<void>;
}

/** The full set of app-schema repositories, bundled for convenient wiring. */
export interface Repos {
  readonly providers: ProviderRepo;
  readonly accounts: AccountRepo;
  readonly identities: IdentityRepo;
  readonly credentials: CredentialRepo;
  readonly sessions: SessionRepo;
  readonly settings: SettingsRepo;
  readonly apiTokens: ApiTokenRepo;
  readonly tags: TagRepo;
  readonly fileTags: FileTagRepo;
  readonly favorites: FavoriteRepo;
  readonly folderViews: FolderViewRepo;
  readonly recents: RecentRepo;
  readonly metadataPaths: MetadataPathRepo;
  readonly systemEvents: SystemEventRepo;
  readonly aiChats: AiChatRepo;
}
