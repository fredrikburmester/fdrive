import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createRepos, migrate } from "@fdrive/db";
import type { Logger } from "pino";
import { registerAdminRoutes } from "./admin/routes.js";
import type { AppHono } from "./app.js";
import { createApp } from "./app.js";
import {
  createAuthModule,
  createLoginLimiter,
  createTokenSource,
  parseMasterKey,
} from "./auth/index.js";
import type { AppConfig } from "./config.js";
import { createLazySftpgoClient } from "./connection/lazy-sftpgo-client.js";
import { createConnectionStore } from "./connection/store.js";
import { createEventBus } from "./events/bus.js";
import { registerEventRoutes } from "./events/routes.js";
import { registerFsRoutes } from "./fs/routes.js";
import { createJobRunner } from "./jobs/runner.js";
import { registerSetupRoutes } from "./setup/routes.js";
import { createSetupService } from "./setup/service.js";
import { createSetupTokenGuard, generateSetupToken } from "./setup/token.js";
import { createSftpgoStorageProvider } from "./storage/sftpgo-provider.js";

export interface ComposeAppDeps {
  /** Overrides the `fetch` implementation the SFTPGo client uses; tests point this at a fake server. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface ComposedApp {
  readonly app: AppHono;
  close(): Promise<void>;
}

/**
 * Wires every fdrive API dependency together: the Postgres pool and repos
 * (running migrations first when `config.fdriveAutoMigrate` is set), the
 * connection store (env `SFTPGO_URL` or `settings`, see
 * `src/connection/store.ts`) and a connection-aware SFTPGo client, the
 * event bus, the login rate limiter, the auth module, the setup module
 * (logging the one-time setup token while setup is required), the admin
 * connection routes, and the fs and events route groups. Returns the
 * resulting `Hono` app plus a `close` that ends the database pool.
 */
export async function composeApp(
  config: AppConfig,
  logger: Logger,
  clock: () => Date = () => new Date(),
  deps: ComposeAppDeps = {},
): Promise<ComposedApp> {
  const master = parseMasterKey(config.fdriveMasterKey);

  const { db, pool } = createDb(config.databaseUrl);
  if (config.fdriveAutoMigrate) {
    await migrate(db);
  }
  const repos = createRepos(db);

  const connectionStore = createConnectionStore({
    settings: repos.settings,
    envUrl: config.sftpgoUrl,
    defaultHomeTemplate: config.fdriveHomeTemplate,
    clock,
  });

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sftpgo = createLazySftpgoClient({ store: connectionStore, fetch: fetchImpl });

  const bus = createEventBus();
  const jobRunner = createJobRunner({ clock, bus });
  const limiter = createLoginLimiter({ clock });
  const tokenSource = createTokenSource({ repos, sftpgo, master, clock });

  const auth = createAuthModule({
    repos,
    sftpgo,
    master,
    clock,
    config,
    limiter,
    tokenSource,
    connectionStore,
    storageFactory: (identityId) =>
      createSftpgoStorageProvider({
        client: sftpgo,
        withToken: (fn) => tokenSource.withToken(identityId, fn),
      }),
  });

  const setupToken = config.fdriveSetupToken ?? generateSetupToken();
  const setupTokenGuard = createSetupTokenGuard(setupToken);
  const setupService = createSetupService({
    connectionStore,
    authService: auth.service,
    accounts: repos.accounts,
    fetch: fetchImpl,
    hasEnvUrl: config.sftpgoUrl !== undefined,
  });

  if ((await connectionStore.current()) === null) {
    logger.info(`setup token: ${setupToken}`);
    logger.info(`open ${config.fdrivePublicUrl ?? ""}/setup to finish setup`);
  }

  const version = readVersion();
  const startedAt = clock();

  const app = createApp({
    config,
    logger,
    clock,
    version,
    startedAt,
    principalResolver: auth.principalResolver,
    connectionStatus: async () => {
      const connection = await connectionStore.current();
      return connection === null
        ? { required: true, host: null }
        : { required: false, host: new URL(connection.baseUrl).host };
    },
    registerRoutes: (groups) => {
      auth.registerRoutes(groups);
      registerSetupRoutes(groups, {
        service: setupService,
        tokenGuard: setupTokenGuard,
        limiter,
        config,
      });
      registerAdminRoutes(groups, { connectionStore, fetch: fetchImpl, clock });
      registerFsRoutes(groups, {
        bus,
        clock,
        jobRunner,
        tmpDir: config.fdriveTmpDir,
        jobMaxBytes: config.fdriveJobMaxBytes,
      });
      registerEventRoutes(groups, { bus, clock });
    },
  });

  return {
    app,
    close: () => pool.end(),
  };
}

/**
 * Reads the api package's own version from its `package.json`, the same way
 * `main.ts` read it before this module took over app composition.
 */
function readVersion(): string {
  const dirName = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(dirName, "..", "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}
