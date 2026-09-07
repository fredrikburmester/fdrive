import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHomeTemplate, parseSearchFilters } from "@fdrive/core";
import {
  createDb,
  createIdentityLinksRepo,
  createIndexQueries,
  createOfficeFileRepo,
  createOfficeWriteScope,
  createRepos,
  createShareRepo,
  createWopiLockRepo,
  migrate,
} from "@fdrive/db";
import { createSftpgoClient } from "@fdrive/sftpgo";
import type { Logger } from "pino";
import { registerAccountsRoutes } from "./accounts/routes.ts";
import { createAccountsService } from "./accounts/service.ts";
import type { AccountsDeps } from "./accounts/types.ts";
import { createAccountViews } from "./accounts/views.ts";
import { registerAdminRoutes } from "./admin/routes.js";
import type { AppHono } from "./app.js";
import { createApp } from "./app.js";
import {
  createAuthModule,
  createLoginLimiter,
  createTokenSource,
  parseMasterKey,
} from "./auth/index.js";
import { createIdentityClientResolver } from "./auth/provider-client.ts";
import { createIdentityStorageFactory } from "./auth/storage-factory.ts";
import type { AppConfig } from "./config.js";
import { createConnectionStore } from "./connection/store.js";
import { ApiHttpError } from "./errors.js";
import { createEventBus } from "./events/bus.js";
import { createIndexerListener, createPgNotificationClient } from "./events/indexer-listener.js";
import { registerEventRoutes } from "./events/routes.js";
import { registerFsRoutes } from "./fs/routes.js";
import { createJobRunner } from "./jobs/runner.js";
import { createIndexerExtractClient } from "./mcp/indexer-client.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { registerMetadataRoutes } from "./metadata/routes.js";
import { createMetadataService } from "./metadata/service.js";
import { officeConfig } from "./office/config.ts";
import { allowsOfficeEdit } from "./office/edit-policy.ts";
import { WopiError } from "./office/errors.ts";
import { createDiscoveryCache } from "./office/protocol/discovery-cache.ts";
import { applyOfficeStorageEvent, withOfficeMetadata } from "./office/registry-events.ts";
import { registerOfficeRoutes, registerWopiRoutes } from "./office/routes.ts";
import { createOfficeService } from "./office/service.ts";
import { createOfficeStorageFactory } from "./office/storage.ts";
import { createOfficeTokenCodec } from "./office/tokens.ts";
import type { OfficeDeps } from "./office/types.ts";
import { createEmbedClient } from "./search/embeddings.js";
import { parseSearchLimit, registerSearchRoutes } from "./search/routes.js";
import { createSearchService } from "./search/service.js";
import { registerSetupRoutes } from "./setup/routes.js";
import { createSetupService } from "./setup/service.js";
import { createSetupTokenGuard, generateSetupToken } from "./setup/token.js";
import { createShareCredentialCodec } from "./shares/credentials.ts";
import { createShareLimiter } from "./shares/limiter.ts";
import { registerSharesRoutes } from "./shares/routes.ts";
import { createSharesService } from "./shares/service.ts";
import { createIndexerClient } from "./system/indexer-client.js";
import { createOcrClient } from "./system/ocr-client.js";
import { registerSystemRoutes } from "./system/routes.js";
import { createThumbnailsRepo } from "./system/thumbnails-repo.js";
import { registerThumbRoutes } from "./thumbs/routes.js";
import { createResolveTokenPrincipal } from "./tokens/principal.js";
import { registerTokenRoutes } from "./tokens/routes.js";
import { createTokenService } from "./tokens/service.js";

export interface ComposeAppDeps {
  /** Explicit server-side admission override for isolated integration fixtures. */
  readonly officeCanEdit?: OfficeDeps["canEdit"];
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
  const clientForBaseUrl = (baseUrl: string) => createSftpgoClient({ baseUrl, fetch: fetchImpl });
  const clientForIdentity = createIdentityClientResolver({
    identities: repos.identities,
    providers: repos.providers,
    connections: connectionStore,
    clientForBaseUrl,
  });

  const bus = createEventBus();
  const jobRunner = createJobRunner({ clock, bus });
  const limiter = createLoginLimiter({ clock });
  const tokenSource = createTokenSource({ repos, clientForIdentity, master, clock });

  const storageFactory = createIdentityStorageFactory({ clientForIdentity, tokenSource });
  const identityLinks = createIdentityLinksRepo(db);
  const auth = createAuthModule({
    identityLinks,
    repos,
    clientForBaseUrl,
    clientForIdentity,
    master,
    clock,
    config,
    limiter,
    tokenSource,
    connectionStore,
    storageFactory,
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

  const accountStorage = createOfficeStorageFactory({
    connections: connectionStore,
    providers: repos.providers,
    tokens: tokenSource,
    fetch: fetchImpl,
  });
  const accountDeps: AccountsDeps = {
    repos,
    links: identityLinks,
    auth: auth.service,
    tokenSource,
    clientForBaseUrl,
    limiter,
    master,
    clock,
    connectionStore,
    storageForIdentity: async (identity) => {
      try {
        return await accountStorage(identity.id, identity.providerId);
      } catch (error) {
        if (error instanceof WopiError && error.status === 401)
          throw new ApiHttpError("upstream_unavailable", "identity provider unavailable");
        throw error;
      }
    },
    searchForIdentity: async (identity, query) => {
      const current = await repos.identities.get(identity.id);
      if (current?.accountId !== identity.accountId)
        throw new ApiHttpError("forbidden", "identity ownership changed");
      const connection = await connectionStore.current();
      if (connection === null)
        throw new ApiHttpError("setup_required", "storage connection unavailable");
      const provider = await repos.providers.ensure({
        type: "sftpgo",
        baseUrl: connection.baseUrl,
      });
      if (provider.id !== identity.providerId)
        throw new ApiHttpError("forbidden", "identity provider unavailable");
      const service = createSearchService({
        indexQueries,
        embedClient,
        homeTemplate: parseHomeTemplate(connection.homeTemplate),
        indexRootNames,
        thumbsEnabled: config.fdriveThumbsDir !== undefined,
        clock,
      });
      return service.search({
        username: identity.externalUsername,
        query: query.q,
        filters: parseSearchFilters(query),
        limit: parseSearchLimit(query.limit),
      });
    },
  };
  const accountsService = createAccountsService(accountDeps);
  const accountViews = createAccountViews(accountDeps);

  // Metadata (phase 3): tags, favorites, recents. `onMoved`/`onDeleted` are
  // called both from the fs routes below (moves and deletes made through
  // fdrive) and from the indexer listener (changes seen over SFTP or any
  // other client), so metadata survives renames from either source.
  const metadataService = createMetadataService(repos);
  const officeFiles = createOfficeFileRepo(db);
  const fsMetadata = withOfficeMetadata(
    metadataService,
    officeFiles,
    repos.identities,
    connectionStore,
    clock,
  );
  const officeSettings = officeConfig(config);
  const officeLocation = async () => {
    const connection = await connectionStore.current();
    if (connection === null) return null;
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: connection.baseUrl });
    return { providerId: provider.id, homeTemplate: parseHomeTemplate(connection.homeTemplate) };
  };
  const officeService = createOfficeService({
    canEdit:
      deps.officeCanEdit ??
      (async (actor, path) =>
        allowsOfficeEdit(config.fdriveOfficeEditRules ?? [], actor.identity, path)),
    config: officeSettings,
    discovery:
      officeSettings === null
        ? null
        : createDiscoveryCache({ serverUrl: officeSettings.serverUrl, fetch: fetchImpl }),
    tokens: createOfficeTokenCodec(master),
    repos,
    files: officeFiles,
    locks: createWopiLockRepo(db),
    withWriteScope: createOfficeWriteScope(db),
    clock,
    location: officeLocation,
    storageFactory: createOfficeStorageFactory({
      connections: connectionStore,
      providers: repos.providers,
      tokens: tokenSource,
      fetch: fetchImpl,
    }),
    metadata: metadataService,
    bus,
  });

  // The indexer's `LISTEN idx_events` connection only has anything to listen
  // for once at least one index root is configured; it is otherwise left
  // unstarted so a deployment without an indexer never opens a spare
  // Postgres connection.
  const indexerListener =
    config.fdriveIndexRoots === null
      ? null
      : createIndexerListener({
          createClient: () => createPgNotificationClient(config.databaseUrl),
          identities: repos.identities,
          indexQueries,
          fileTags: repos.fileTags,
          favorites: repos.favorites,
          metadata: metadataService,
          onStorageEvent: async (event) => {
            const location = await officeLocation();
            if (location !== null)
              await applyOfficeStorageEvent(officeFiles, location.providerId, event);
          },
          bus,
          homeTemplate,
          indexRootNames,
          clock,
          logger,
        });
  if (indexerListener !== null) {
    await indexerListener.start();
  }

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
    storageFactory,
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
      registerSharesRoutes(groups, {
        service: createSharesService({
          repos,
          shares: createShareRepo(db),
          clientFor: (baseUrl) => createSftpgoClient({ baseUrl, fetch: fetchImpl }),
          tokenSource,
          connectionStore,
          clock,
          logger,
        }),
        codec: createShareCredentialCodec(master, clock),
        limiter: createShareLimiter(clock),
        config,
      });
      registerAccountsRoutes(groups, {
        service: accountsService,
        views: accountViews,
        config,
        clock,
      });
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
        metadata: fsMetadata,
      });
      registerOfficeRoutes(groups, { service: officeService });
      registerMetadataRoutes(groups, { metadata: metadataService });
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

  registerWopiRoutes(app, { service: officeService });

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
    close: async () => {
      if (indexerListener !== null) {
        await indexerListener.stop();
      }
      await pool.end();
    },
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
