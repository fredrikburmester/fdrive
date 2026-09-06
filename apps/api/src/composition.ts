import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHomeTemplate } from "@fdrive/core";
import { createDb, createIndexQueries, createRepos, migrate } from "@fdrive/db";
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
import { createIndexerExtractClient } from "./mcp/indexer-client.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { createEmbedClient } from "./search/embeddings.js";
import { registerSearchRoutes } from "./search/routes.js";
import { createSearchService } from "./search/service.js";
import { registerSetupRoutes } from "./setup/routes.js";
import { createSetupService } from "./setup/service.js";
import { createSetupTokenGuard, generateSetupToken } from "./setup/token.js";
import { createSftpgoStorageProvider } from "./storage/sftpgo-provider.js";
import { createIndexerClient } from "./system/indexer-client.js";
import { createOcrClient } from "./system/ocr-client.js";
import { registerSystemRoutes } from "./system/routes.js";
import { createThumbnailsRepo } from "./system/thumbnails-repo.js";
import { registerThumbRoutes } from "./thumbs/routes.js";
import { createResolveTokenPrincipal } from "./tokens/principal.js";
import { registerTokenRoutes } from "./tokens/routes.js";
import { createTokenService } from "./tokens/service.js";

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

  // Search and thumbnails: available only once at least one index root is
  // configured (`FDRIVE_INDEX_ROOTS`); the search route itself degrades to
  // `{ unavailable: true }` rather than erroring when it is not.
  const indexQueries = createIndexQueries(db);
  const homeTemplate = parseHomeTemplate(config.fdriveHomeTemplate);
  const indexRootNames = new Set((config.fdriveIndexRoots ?? []).map((root) => root.name));
  const embedClient =
    config.fdriveEmbedUrl === undefined
      ? null
      : createEmbedClient({ baseUrl: config.fdriveEmbedUrl });
  const searchService = createSearchService({
    indexQueries,
    embedClient,
    homeTemplate,
    indexRootNames,
    thumbsEnabled: config.fdriveThumbsDir !== undefined,
    clock,
  });

  // System pages (phase 2): sidecar clients are `null` when their base URL
  // is not configured, so the routes degrade to "not configured" rather
  // than failing.
  const indexerClient =
    config.fdriveIndexerUrl === undefined
      ? null
      : createIndexerClient({ baseUrl: config.fdriveIndexerUrl, fetch: fetchImpl });
  const ocrClient =
    config.fdriveOcrUrl === undefined
      ? null
      : createOcrClient({ baseUrl: config.fdriveOcrUrl, fetch: fetchImpl });
  const thumbnailsRepo = createThumbnailsRepo(db);

  const tokenService = createTokenService({
    apiTokens: repos.apiTokens,
    identities: repos.identities,
    clock,
  });
  const resolveTokenPrincipal = createResolveTokenPrincipal({
    apiTokens: repos.apiTokens,
    identities: repos.identities,
    clock,
    storageFactory: (identityId) =>
      createSftpgoStorageProvider({
        client: sftpgo,
        withToken: (fn) => tokenSource.withToken(identityId, fn),
      }),
  });
  // The MCP `read_file_text` tool talks to the indexer's `POST /extract`
  // endpoint, a different shape from the System pages' `IndexerClient`
  // (`/health`, `/stats`, ...), so it gets its own client. Both point at the
  // same `FDRIVE_INDEXER_URL` and share `fetchImpl`.
  const indexerExtractClient =
    config.fdriveIndexerUrl === undefined
      ? null
      : createIndexerExtractClient({ baseUrl: config.fdriveIndexerUrl, fetch: fetchImpl });

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
      registerSearchRoutes(groups, { searchService });
      registerThumbRoutes(groups, {
        indexQueries,
        homeTemplate,
        indexRootNames,
        thumbsDir: config.fdriveThumbsDir,
      });
      registerSystemRoutes(groups, {
        settings: repos.settings,
        indexQueries,
        thumbnailsRepo,
        indexerClient,
        ocrClient,
        embedUrl: config.fdriveEmbedUrl,
        thumbsDir: config.fdriveThumbsDir,
        indexRootNames: Array.from(indexRootNames),
        fetch: fetchImpl,
      });
      registerTokenRoutes(groups, { service: tokenService });
    },
  });

  // Mounted directly on the top-level app, outside `/api/v1`: the MCP
  // endpoint is bearer- (or path-token-) authenticated, not session/CSRF
  // guarded, and `resolveMcpPrincipal` never touches the session cookie.
  registerMcpRoutes(app, {
    resolveToken: resolveTokenPrincipal,
    toolDeps: {
      indexQueries,
      homeTemplate,
      indexRootNames,
      searchService,
      fdrivePublicUrl: config.fdrivePublicUrl,
      indexerClient: indexerExtractClient,
      writesEnabled: config.fdriveMcpWrites,
      clock,
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
