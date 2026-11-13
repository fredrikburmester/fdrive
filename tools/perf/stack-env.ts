export interface StackEnvInput {
  readonly databaseUrl: string;
  /** The temporary folder the api serves as its local storage, one home per user. */
  readonly storageRoot: string;
  readonly masterKeyBase64: string;
}

/**
 * Builds the process-environment-shaped object `loadConfig` from
 * `apps/api/src/config.ts` expects for the perf stack: a real Postgres, the
 * fixture folder as the local storage root, a random master key,
 * `FDRIVE_COOKIE_SECURE=false` (the perf harness talks plain HTTP), and
 * `LOG_LEVEL=warn` to keep the harness's output focused on its own tables
 * rather than the API's request log. Everything else is left for
 * `loadConfig`'s own defaults. Pure.
 */
export function buildStackEnv(input: StackEnvInput): Record<string, string> {
  return {
    DATABASE_URL: input.databaseUrl,
    FDRIVE_STORAGE_ROOT: input.storageRoot,
    FDRIVE_MASTER_KEY: input.masterKeyBase64,
    FDRIVE_COOKIE_SECURE: "false",
    LOG_LEVEL: "warn",
  };
}
