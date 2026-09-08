import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSearchFilters } from "@fdrive/core";
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
import { type Subsystem, startupSummaryLines } from "./config-keys.js";
import { createConnectionStore } from "./connection/store.js";
import { ApiHttpError } from "./errors.js";
import { createEventBus } from "./events/bus.js";
import { createIndexerListener, createPgNotificationClient } from "./events/indexer-listener.js";
import { registerEventRoutes } from "./events/routes.js";
import { registerFeatureAdmission } from "./features/admission.js";
import { registerFeatureRoutes } from "./features/routes.js";
import { createFeatureService } from "./features/service.js";
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
import { createSettingsScopeOverrideStore } from "./scoping/override-store.ts";
import { createReadAuthorizer } from "./scoping/read-authorizer.ts";
import { createScopeResolver } from "./scoping/resolver.ts";
import { registerScopeRoutes } from "./scoping/routes.ts";
import { createEmbedClient } from "./search/embeddings.js";
import { createImageEmbedClient } from "./search/image-embed-client.js";
import { createImageSearchService } from "./search/image-service.js";
import { parseSearchLimit, registerSearchRoutes } from "./search/routes.js";
import { createSearchService } from "./search/service.js";
import { createSetupClaimStore } from "./setup/claim.js";
import { registerSetupInventoryRoutes } from "./setup/inventory-routes.js";
import { registerSetupRoutes } from "./setup/routes.js";
import { createSetupService } from "./setup/service.js";
import { createSetupTokenGuard, generateSetupToken } from "./setup/token.js";
import { createShareCredentialCodec } from "./shares/credentials.ts";
import { createShareLimiter } from "./shares/limiter.ts";
import { registerSharesRoutes } from "./shares/routes.ts";
import { createSharesService } from "./shares/service.ts";
import { createCachedProbe } from "./system/cached-probe.js";
import { fetchEmbedStatus } from "./system/embed-status.js";
import { createIndexerClient, type IndexerClient } from "./system/indexer-client.js";
import { createOcrClient } from "./system/ocr-client.js";
import { registerSystemRoutes } from "./system/routes.js";
import { createThumbnailsRepo } from "./system/thumbnails-repo.js";
import { registerThumbRoutes } from "./thumbs/routes.js";
import { createResolveTokenPrincipal } from "./tokens/principal.js";
import { registerTokenRoutes } from "./tokens/routes.js";
import { createTokenService } from "./tokens/service.js";
import { registerTrashRoutes } from "./trash/routes.js";

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

/** How long one `/health` sidecar reachability fan-out is reused; see `createCachedProbe`. */
const HEALTH_PROBE_TTL_MS = 15_000;

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
  // A misconfigured fdrive must say what is missing, by variable name, at
  // startup: see docs/workflow/P7-CONFIG-LOUDNESS.md. One line per
  // subsystem, logged before anything else touches the network.
  for (const line of startupSummaryLines(config)) {
    logger.info(line);
  }

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
  const featureService = createFeatureService({
    settings: repos.settings,
    config,
    fetch: fetchImpl,
  });
  const featureValues = async () => (await featureService.configuration()).values;
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

  const storageFactory = createIdentityStorageFactory({
    clientForIdentity,
    tokenSource,
    ...(config.fdriveSftpgoTrashPath === null ? {} : { trashPath: config.fdriveSftpgoTrashPath }),
  });
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

  // System pages (phase 2) and the scope engine both need the indexer's
  // internal HTTP client; built once here so `scopeResolver` below can use
  // it too. `null` when `FDRIVE_INDEXER_URL` is not configured, in which
  // case the scope resolver treats every directory-verification probe as
  // unreachable rather than failing to construct.
  const indexerClient =
    config.fdriveIndexerUrl === undefined
      ? null
      : createIndexerClient({ baseUrl: config.fdriveIndexerUrl, fetch: fetchImpl });
  const scopeIndexerDirectory: Pick<IndexerClient, "directory"> =
    indexerClient ??
    ({
      directory: async () => ({
        ok: false,
        reason: "unreachable",
        detail: "indexer not configured",
      }),
    } satisfies Pick<IndexerClient, "directory">);

  // The single source of truth for what every identity may read: trusted
  // configured mappings (home template + per-identity overrides, available
  // even when the indexer is down) plus index-verified scopes (restricted
  // further by a live SFTP-vs-indexer directory check). See
  // `docs/workflow/P5-SCOPES.md`.
  const scopeResolver = createScopeResolver({
    providers: repos.providers,
    overrides: createSettingsScopeOverrideStore(repos.settings),
    connection: connectionStore,
    indexRoots: config.fdriveIndexRoots,
    indexer: scopeIndexerDirectory,
    storageForIdentity: (identity) => storageFactory(identity.id),
    clock,
  });

  // Search: available only once at least one index root is configured
  // (`FDRIVE_INDEX_ROOTS`); the search route itself degrades to
  // `{ unavailable: true }` rather than erroring when the caller's
  // verified index scopes are unavailable for any reason.
  const indexQueries = createIndexQueries(db);
  const embedClient =
    config.fdriveEmbedUrl === undefined
      ? null
      : createEmbedClient({ baseUrl: config.fdriveEmbedUrl });
  const imageEmbedClient =
    config.fdriveImageEmbedUrl === undefined
      ? null
      : createImageEmbedClient({ baseUrl: config.fdriveImageEmbedUrl, fetch: fetchImpl });
  const searchService = createSearchService({
    features: featureValues,
    indexQueries,
    embedClient,
    thumbsEnabled: config.fdriveThumbsDir !== undefined,
    trashPath: config.fdriveSftpgoTrashPath,
    clock,
  });
  // The sidecar's own health (model id + dim) is cached for 15s so it is not
  // re-fetched on every keystroke; a failed or stale-dim probe just makes
  // image search report `unavailable: true` rather than erroring.
  const resolveImageEmbedHealth = createCachedProbe(
    () => (imageEmbedClient === null ? Promise.resolve(null) : imageEmbedClient.health()),
    { ttlMs: HEALTH_PROBE_TTL_MS, clock: () => clock().getTime() },
  );
  const imageSearchService = createImageSearchService({
    enabled: () => featureService.enabled("imageSearch"),
    indexQueries,
    imageEmbedClient,
    resolveHealth: resolveImageEmbedHealth,
    trashPath: config.fdriveSftpgoTrashPath,
    clock,
  });

  const accountStorage = createOfficeStorageFactory({
    connections: connectionStore,
    providers: repos.providers,
    tokens: tokenSource,
    fetch: fetchImpl,
  });
  const identityStorageForAccount = async (identity: { id: string; providerId: string }) => {
    try {
      return await accountStorage(identity.id, identity.providerId);
    } catch (error) {
      if (error instanceof WopiError && error.status === 401)
        throw new ApiHttpError("upstream_unavailable", "identity provider unavailable");
      throw error;
    }
  };
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
    storageForIdentity: identityStorageForAccount,
    searchForIdentity: async (identity, query) => {
      const current = await repos.identities.get(identity.id);
      if (current?.accountId !== identity.accountId)
        throw new ApiHttpError("forbidden", "identity ownership changed");
      const verified = await scopeResolver.verifiedIndexScopes(identity);
      const storage = await identityStorageForAccount(identity);
      return searchService.search({
        scopes: verified.available ? verified.scopes : [],
        authorizer: createReadAuthorizer({ storage }),
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
    scopeResolver.configuredMappings,
    clock,
  );
  const officeSettings = officeConfig(config);
  const officeLocation: OfficeDeps["location"] = async (identity) => {
    const configured = await scopeResolver.configuredMappings(identity);
    return configured.available
      ? { providerId: configured.providerId, scopes: configured.scopes }
      : null;
  };
  /** The provider id of the currently configured connection, independent of any identity; used only to route indexer registry events. */
  const currentOfficeProviderId = async (): Promise<string | null> => {
    const connection = await connectionStore.current();
    if (connection === null) return null;
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: connection.baseUrl });
    return provider.id;
  };
  // Shared with `subsystemReachability` below (the `/health` route's office
  // liveness probe), so office discovery is only ever cached once.
  const officeDiscovery =
    officeSettings === null
      ? null
      : createDiscoveryCache({ serverUrl: officeSettings.serverUrl, fetch: fetchImpl });
  const officeService = createOfficeService({
    canEdit:
      deps.officeCanEdit ??
      (async (actor, path) =>
        allowsOfficeEdit(config.fdriveOfficeEditRules ?? [], actor.identity, path)),
    config: officeSettings,
    discovery: officeDiscovery,
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
  const indexRootNames = new Set((config.fdriveIndexRoots ?? []).map((root) => root.name));
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
            const providerId = await currentOfficeProviderId();
            if (providerId !== null) await applyOfficeStorageEvent(officeFiles, providerId, event);
          },
          bus,
          configuredMappingsFor: scopeResolver.configuredMappings,
          storageForIdentity: (identityId) => storageFactory(identityId),
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
    claims: createSetupClaimStore(repos.settings),
    fetch: fetchImpl,
    hasEnvUrl: config.sftpgoUrl !== undefined,
  });

  if ((await setupService.status()).required) {
    // One-time credential: the guard invalidates it after setup, and setup cannot be
    // re-run, but the line still lands in log storage. Operators rotate logs afterwards.
    logger.warn(`setup token: ${setupToken}`);
    logger.warn("the setup token is one-time and invalidated after setup; rotate logs afterwards");
    logger.info(`open ${config.fdrivePublicUrl ?? ""}/setup to finish setup`);
  }

  const version = readVersion();
  const startedAt = clock();

  // GET /api/v1/health's `subsystems` field: reuses each sidecar's existing
  // liveness probe (the same ones the System pages already poll), so a
  // subsystem that is configured but unreachable is visible from this
  // public, unauthenticated endpoint too, not only from an admin session.
  // The fan-out is cached for HEALTH_PROBE_TTL_MS and shared between
  // concurrent requests, so anonymous health polling cannot be turned into
  // load at the sidecars.
  const probeSubsystems = async (
    forConfig: AppConfig,
  ): Promise<Partial<Record<Subsystem, boolean>>> => {
    const [indexResult, searchStatus, imageSearchResult, ocrResult, officeReachable] =
      await Promise.all([
        indexerClient === null ? Promise.resolve(null) : indexerClient.health(),
        forConfig.fdriveEmbedUrl === undefined
          ? Promise.resolve(null)
          : fetchEmbedStatus({ baseUrl: forConfig.fdriveEmbedUrl, fetch: fetchImpl }),
        imageEmbedClient === null ? Promise.resolve(null) : imageEmbedClient.health(),
        ocrClient === null ? Promise.resolve(null) : ocrClient.health(),
        officeDiscovery === null
          ? Promise.resolve(null)
          : officeDiscovery.get().then(
              () => true,
              () => false,
            ),
      ]);
    return {
      ...(indexResult === null ? {} : { index: indexResult.ok }),
      ...(searchStatus === null ? {} : { search: searchStatus.healthy }),
      // A sidecar that answered but is still loading its model is treated as
      // unreachable here: it cannot yet serve an embedding, so it is not
      // usefully "up" from the health endpoint's point of view.
      ...(imageSearchResult === null
        ? {}
        : { imageSearch: imageSearchResult.ok && imageSearchResult.data.status === "ok" }),
      ...(ocrResult === null ? {} : { ocr: ocrResult.ok }),
      ...(officeReachable === null ? {} : { office: officeReachable }),
    };
  };
  const cachedProbe = createCachedProbe(() => probeSubsystems(config), {
    ttlMs: HEALTH_PROBE_TTL_MS,
    clock: () => clock().getTime(),
  });
  const subsystemReachability = () => cachedProbe();

  const app = createApp({
    config,
    logger,
    clock,
    version,
    startedAt,
    subsystemReachability,
    principalResolver: auth.principalResolver,
    connectionStatus: async () => {
      const setup = await setupService.status();
      const connection = await connectionStore.current();
      return setup.required || connection === null
        ? { required: true, host: null }
        : { required: false, host: new URL(connection.baseUrl).host };
    },
    registerRoutes: (groups) => {
      registerFeatureAdmission(groups.authed, featureService);
      registerFeatureRoutes(groups, {
        service: featureService,
        workerToken: config.fdriveWorkerToken,
      });
      auth.registerRoutes(groups);
      registerSharesRoutes(groups, {
        thumbnailsEnabled: () => featureService.enabled("thumbnails"),
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
        indexQueries,
        resolver: scopeResolver,
        identities: repos.identities,
        thumbsDir: config.fdriveThumbsDir,
      });
      registerAccountsRoutes(groups, {
        service: accountsService,
        views: accountViews,
        config,
        clock,
      });
      registerScopeRoutes(groups, { resolver: scopeResolver, identities: repos.identities });
      registerSetupRoutes(groups, {
        service: setupService,
        tokenGuard: setupTokenGuard,
        limiter,
        config,
      });
      registerSetupInventoryRoutes(groups, { connectionStore, fetch: fetchImpl, limiter, config });
      registerAdminRoutes(groups, { connectionStore, fetch: fetchImpl, clock });
      // Built as a local variable (not a fresh object literal at the call
      // site below) so `archivePeekMaxBytes` (not part of `FsRoutesDeps`
      // itself; see `fs/archive-routes.ts`'s `ArchiveRoutesDeps`) reaches
      // `registerArchiveRoutes` without TypeScript's excess-property check
      // rejecting it.
      const fsRoutesDeps = {
        bus,
        clock,
        jobRunner,
        tmpDir: config.fdriveTmpDir,
        jobMaxBytes: config.fdriveJobMaxBytes,
        archivePeekMaxBytes: config.fdriveArchivePeekMaxBytes,
        jsonMaxBytes: config.fdriveJsonMaxBytes,
        metadata: fsMetadata,
        ...(config.fdriveSftpgoTrashPath === null
          ? {}
          : { trashPath: config.fdriveSftpgoTrashPath }),
        folderSize: {
          indexQueries,
          resolver: scopeResolver,
          identities: repos.identities,
          ...(config.fdriveSftpgoTrashPath === null
            ? {}
            : { trashPath: config.fdriveSftpgoTrashPath }),
        },
      };
      registerFsRoutes(groups, fsRoutesDeps);
      registerTrashRoutes(groups, {
        bus,
        clock,
        trashPath: config.fdriveSftpgoTrashPath,
        retentionHours: config.fdriveSftpgoTrashRetentionHours,
        metadata: fsMetadata,
      });
      registerOfficeRoutes(groups, { service: officeService });
      registerMetadataRoutes(groups, { metadata: metadataService });
      registerEventRoutes(groups, { bus, clock });
      registerSearchRoutes(groups, {
        features: featureValues,
        searchService,
        imageSearchService,
        resolver: scopeResolver,
        identities: repos.identities,
        semanticEnabled: embedClient !== null,
        imageSearchEnabled: imageEmbedClient !== null,
      });
      registerThumbRoutes(groups, {
        enabled: () => featureService.enabled("thumbnails"),
        indexQueries,
        resolver: scopeResolver,
        identities: repos.identities,
        thumbsDir: config.fdriveThumbsDir,
      });
      registerSystemRoutes(groups, {
        featuresManaged: config.fdriveFeaturesManaged ?? false,
        settings: repos.settings,
        indexQueries,
        thumbnailsRepo,
        indexerClient,
        ocrClient,
        embedUrl: config.fdriveEmbedUrl,
        imageEmbedClient,
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
      searchService,
      scopeResolver,
      identities: repos.identities,
      fdrivePublicUrl: config.fdrivePublicUrl,
      indexerClient: indexerExtractClient,
      writesEnabled: config.fdriveMcpWrites,
      clock,
      trashPath: config.fdriveSftpgoTrashPath,
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
