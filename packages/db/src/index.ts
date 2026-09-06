import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { resolveMigrationsFolder } from "./migrationsPath.js";
import * as appSchema from "./schema/app.js";
import * as idxSchema from "./schema/idx.js";

export { resolveMigrationsFolder } from "./migrationsPath.js";
export * from "./parseDatabaseUrl.js";
export { createRepos } from "./repos/drizzle.js";
export type {
  ContentHit,
  DuplicateGroup,
  DuplicateLocation,
  FilenameHit,
  IndexedFile,
  IndexQueries,
  IndexStats,
  ScopeClause,
  ScopePrefix,
  SimilarFile,
} from "./repos/index-queries.js";
export {
  createIndexQueries,
  escapeLikePattern,
  toScopeClauses,
} from "./repos/index-queries.js";
export type {
  Account,
  AccountRepo,
  Credential,
  CredentialRepo,
  Identity,
  IdentityRepo,
  Provider,
  ProviderRepo,
  Repos,
  Session,
  SessionRepo,
  SettingsRepo,
} from "./repos/types.js";
export * from "./vector.js";

export const schema = { ...appSchema, ...idxSchema };
export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;

export interface CreateDbOptions {
  readonly max?: number;
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
