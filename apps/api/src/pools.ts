import { type CreateDbResult, createDb } from "@fdrive/db";

/**
 * The API's database pools, in the order a request takes them. Work holding
 * a connection from one pool waits only for a connection from a pool after
 * it, never from its own or one before it, so however full they are no two
 * holders wait for each other. Every fdrive process's share of the
 * database's connections is in docs/ARCHITECTURE.md, "Database connections".
 */
export const API_POOLS = {
  /**
   * Each mutating request holds the backups' snapshot gate, shared, from its
   * start to its end, an upload's body included (`withDatabaseWriter`). Used
   * only while backups are configured. A write that finds every connection
   * taken waits for one, however long: it holds nothing yet.
   */
  writeGate: 16,
  /** An Office save holds its document's lock, and a connection, while its body arrives. */
  office: 10,
  /** A file operation's transaction holds the paths it changes while its storage call runs. */
  fileOperations: 10,
  /** Everything else, backups included. It waits for no other pool. */
  main: 10,
} as const;

export type ApiPoolName = keyof typeof API_POOLS;

/** How long work waits for a connection before it fails; the write gate waits as long as it takes. */
export const CONNECTION_WAIT_MS = 30_000;

/** The backup worker's own pool (`backup worker`): its lock, a capture and their bookkeeping. */
export const BACKUP_WORKER_POOL = 6;

/**
 * The most connections each fdrive process opens at once. The indexer's and
 * OCR's are set in their own code; a test reads them from there.
 */
export const CONNECTION_BUDGET = {
  /** Its four pools and the change journal's `LISTEN` connection. */
  api: Object.values(API_POOLS).reduce((sum, size) => sum + size, 0) + 1,
  backupWorker: BACKUP_WORKER_POOL,
  /**
   * One per thread that reads the database: three pools of up to 16 workers
   * (`MAX_WORKERS`: scan, journal and watcher), ten threads of its own, and
   * the HTTP handlers' threads (`HTTP_BLOCKING_THREADS`, 8).
   */
  indexer: 3 * 16 + 10 + 8,
  /**
   * A pass, the settings poll, one request at a time on the event loop, and
   * restores and deletes of kept originals (`ORIGINALS_AT_ONCE`, 2).
   */
  ocr: 3 + 2,
  /** `psql`, the backup commands and other one-off tools an operator runs. */
  operator: 10,
} as const;

/** What the deployment's Postgres allows (`max_connections` in deploy/compose.yaml). */
export const POSTGRES_MAX_CONNECTIONS = 200;

/** Postgres keeps this many of `max_connections` for superusers (`superuser_reserved_connections`). */
export const POSTGRES_RESERVED_CONNECTIONS = 3;

export type ApiPools = Readonly<Record<ApiPoolName, CreateDbResult>> & {
  close(): Promise<void>;
};

/**
 * Opens the API's pools, each named `fdrive api <pool>` in `pg_stat_activity`.
 * They connect on first use, so a pool nothing uses (the write gate without
 * backups) opens no connection.
 */
export function openApiPools(
  databaseUrl: string,
  onError: (pool: ApiPoolName, error: Error) => void,
): ApiPools {
  const open = (name: ApiPoolName): CreateDbResult =>
    createDb(databaseUrl, {
      max: API_POOLS[name],
      applicationName: `fdrive api ${name}`,
      ...(name === "writeGate" ? {} : { connectionTimeoutMillis: CONNECTION_WAIT_MS }),
      onError: (error) => onError(name, error),
    });
  const pools = {
    writeGate: open("writeGate"),
    office: open("office"),
    fileOperations: open("fileOperations"),
    main: open("main"),
  };
  return {
    ...pools,
    close: async () => {
      for (const pool of Object.values(pools)) await pool.close();
    },
  };
}
