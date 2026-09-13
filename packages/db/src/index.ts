import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { resolveMigrationsFolder } from "./migrations-path.js";
import * as appSchema from "./schema/app.js";
import * as idxSchema from "./schema/idx.js";

export { resolveMigrationsFolder } from "./migrations-path.js";
export * from "./parse-database-url.js";
export { createRepos } from "./repos/drizzle.js";
export { createIdentityLinksRepo, createIdentityOwnershipGuard } from "./repos/identity-links.js";
export type {
  IdentityLinksErrorCode,
  IdentityLinksRepo,
  LinkVerifiedInput,
  LoginSessionInput,
  LoginVerifiedInput,
  LoginVerifiedResult,
  RotateSessionInput,
  SealedIdentityCredential,
  SwitchActiveIdentityInput,
  UnlinkIdentityInput,
  UnlinkIdentityResult,
} from "./repos/identity-links-types.js";
export {
  IdentityLinksError,
  validateIdentityLinkId,
  validateLinkVerified,
  validateLoginVerified,
  validateRotateSession,
  validateSealedIdentityCredential,
  validateSessionIdHash,
  validateSwitchActiveIdentity,
  validateUnlinkIdentity,
} from "./repos/identity-links-types.js";
export type {
  ContentHit,
  DuplicateGroup,
  DuplicateLocation,
  FileFilter,
  FilenameHit,
  FileOrder,
  ImageEmbeddingStats,
  ImageSearchHit,
  IndexedFile,
  IndexQueries,
  IndexStats,
  MoveRecord,
  ScopeClause,
  ScopePrefix,
  SimilarFile,
} from "./repos/index-queries.js";
export {
  createIndexQueries,
  escapeLikePattern,
  toScopeClauses,
} from "./repos/index-queries.js";
export { createOfficeFileRepo } from "./repos/office-files.js";
export type {
  MemoryOfficeFileOptions,
  OfficeFile,
  OfficeFileDelete,
  OfficeFileLocation,
  OfficeFileMove,
  OfficeFileRepo,
} from "./repos/office-files-state.js";
export { createMemoryOfficeFileRepo } from "./repos/office-files-state.js";
export type { OfficeWriteContext, OfficeWriteScope } from "./repos/office-write-scope.js";
export { createOfficeWriteScope } from "./repos/office-write-scope.js";
export { createShareRepo } from "./repos/shares.js";
export type {
  MemoryShareOptions,
  ShareListOptions,
  SharePresentation,
  ShareRecord,
  ShareRepo,
  ShareScope,
  ShareUpsertInput,
} from "./repos/shares-state.js";
export {
  createMemoryShareRepo,
  parseSharePresentation,
  parseShareScope,
  shareListLimit,
  validateShareId,
  validateShareOwnership,
  validateSharePath,
  validateShareUpsert,
} from "./repos/shares-state.js";
export { createSystemEventRepo } from "./repos/system-events.js";
export type {
  Account,
  AccountRepo,
  ApiToken,
  ApiTokenRepo,
  Credential,
  CredentialRepo,
  Favorite,
  FavoriteKind,
  FavoriteRepo,
  FileTagRepo,
  FolderView,
  FolderViewMode,
  FolderViewRepo,
  FolderViewSort,
  FolderViewSortDirection,
  FolderViewSortKey,
  Identity,
  IdentityRepo,
  MetadataPathRepo,
  Provider,
  ProviderRepo,
  Recent,
  RecentRepo,
  Repos,
  Session,
  SessionRepo,
  SettingsRepo,
  SystemEvent,
  SystemEventLevel,
  SystemEventListOptions,
  SystemEventRepo,
  SystemEventSource,
  Tag,
  TagRepo,
} from "./repos/types.js";
export { ConflictError, levelsAtLeast, SYSTEM_EVENT_LEVELS } from "./repos/types.js";
export type {
  BoundWopiLockRepo,
  LockInput,
  LockOperation,
  LockRequest,
  LockResult,
  WopiLockRepo,
  WopiLockState,
  WopiLockTransition,
} from "./repos/wopi-lock-state.js";
export {
  createMemoryWopiLockRepo,
  transitionWopiLock,
  WOPI_FILE_ID_MAX_BYTES,
  WOPI_LOCK_TTL_MS,
} from "./repos/wopi-lock-state.js";
export { createWopiLockRepo } from "./repos/wopi-locks.js";
export * from "./vector.js";

export const schema = { ...appSchema, ...idxSchema };
export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;

export interface CreateDbOptions {
  readonly max?: number;
  /**
   * Receives the errors `pg` raises on behalf of idle pooled clients (a
   * backend restart, a dropped connection). Without a listener Node treats
   * them as uncaught exceptions and exits the process; the pool itself
   * recovers by reconnecting on the next checkout. Defaults to ignoring them.
   */
  readonly onError?: (error: Error) => void;
}

export interface CreateDbResult {
  readonly db: Db;
  readonly pool: Pool;
  close(): Promise<void>;
}

/**
 * Creates a connection pool and a typed Drizzle database over it. The
 * caller owns the returned pool's lifecycle and must call `close()` when
 * done, typically on process shutdown.
 */
export function createDb(connectionString: string, opts: CreateDbOptions = {}): CreateDbResult {
  const pool = new Pool({
    connectionString,
    ...(opts.max === undefined ? {} : { max: opts.max }),
  });
  pool.on("error", opts.onError ?? (() => {}));
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

/**
 * Applies every committed migration under `drizzle/` that has not yet run.
 * Safe to call repeatedly: drizzle tracks applied migrations in its own
 * bookkeeping table and a second call is a no-op.
 */
export async function migrate(db: Db): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder(import.meta.url);
  await runMigrations(db, { migrationsFolder });
}
export {
  createProcessingFailureReader,
  type ProcessingFailureReader,
} from "./repos/processing-failures.js";
