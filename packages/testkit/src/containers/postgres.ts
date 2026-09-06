import { PostgreSqlContainer } from "@testcontainers/postgresql";

const DEFAULT_IMAGE = "pgvector/pgvector:pg17";
const DATABASE_NAME = "fdrive";
const DATABASE_USER = "fdrive";
/** Fixed test-only credential; never used outside ephemeral testcontainers. */
const DATABASE_PASSWORD = "fdrive-test-password";

export interface StartPostgresOptions {
  readonly image?: string;
}

export interface PostgresContainer {
  readonly connectionString: string;
  stop(): Promise<void>;
}

/**
 * Starts a disposable Postgres container (pgvector/pgvector:pg17 by default)
 * with a fixed database name and user, for use by integration tests that
 * need a real Postgres instance.
 */
export async function startPostgres(
  options: StartPostgresOptions = {},
): Promise<PostgresContainer> {
  const started = await new PostgreSqlContainer(options.image ?? DEFAULT_IMAGE)
    .withDatabase(DATABASE_NAME)
    .withUsername(DATABASE_USER)
    .withPassword(DATABASE_PASSWORD)
    .start();

  return {
    connectionString: started.getConnectionUri(),
    stop: async () => {
      await started.stop();
    },
  };
}
