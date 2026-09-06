import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createRepos, migrate } from "@fdrive/db";
import { createSftpgoClient } from "@fdrive/sftpgo";
import type { Logger } from "pino";
import type { AppHono } from "./app.js";
import { createApp } from "./app.js";
import {
  createAuthModule,
  createLoginLimiter,
  createTokenSource,
  parseMasterKey,
} from "./auth/index.js";
import type { AppConfig } from "./config.js";
import { createEventBus } from "./events/bus.js";
import { registerEventRoutes } from "./events/routes.js";
import { registerFsRoutes } from "./fs/routes.js";
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
 * SFTPGo client, the event bus, the login rate limiter, the auth module
 * (which supplies the principal resolver and its own routes), and the fs
 * and events route groups. Returns the resulting `Hono` app plus a `close`
 * that ends the database pool.
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

  const sftpgoOptions: Parameters<typeof createSftpgoClient>[0] =
    deps.fetch === undefined
      ? { baseUrl: config.sftpgoUrl }
      : { baseUrl: config.sftpgoUrl, fetch: deps.fetch };
  const sftpgo = createSftpgoClient(sftpgoOptions);

  const bus = createEventBus();
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
    storageFactory: (identityId) =>
      createSftpgoStorageProvider({
        client: sftpgo,
        withToken: (fn) => tokenSource.withToken(identityId, fn),
      }),
  });

  const version = readVersion();
  const startedAt = clock();

  const app = createApp({
    config,
    logger,
    clock,
    version,
    startedAt,
    principalResolver: auth.principalResolver,
    registerRoutes: (groups) => {
      auth.registerRoutes(groups);
      registerFsRoutes(groups, { bus, clock });
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
