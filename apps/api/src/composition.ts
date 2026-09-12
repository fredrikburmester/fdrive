import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSearchFilters, type StorageProvider } from "@fdrive/core";
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
import type { AppHono } from "./app.js";
import { createApp } from "./app.js";
import {
  createAuthModule,
  createLoginLimiter,
  createTokenSource,
  parseMasterKey,
} from "./auth/index.js";
import {
  createIdentityStorageFactory,
  createPinnedStorageFactory,
  trashSettingsForStorage,
} from "./auth/storage-factory.ts";
import type { AppConfig } from "./config.js";
import { type Subsystem, type SubsystemProbe, startupSummaryLines } from "./config-keys.js";
import { ApiHttpError } from "./errors.js";
import { createEventBus } from "./events/bus.js";
import { createIndexerListener, createPgNotificationClient } from "./events/indexer-listener.js";
import { registerEventRoutes } from "./events/routes.js";
import { registerFeatureAdmission } from "./features/admission.js";
import { registerFeatureRoutes } from "./features/routes.js";
import { createFeatureService } from "./features/service.js";
import { publishFsEvent, registerFsRoutes } from "./fs/routes.js";
import { createJobRunner } from "./jobs/runner.js";
import { createIndexerExtractClient } from "./mcp/indexer-client.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { registerMetadataRoutes } from "./metadata/routes.js";
import { createMetadataService } from "./metadata/service.js";
import { extractClientIp } from "./net.js";
import { configuredOfficeProduct, officeConfig } from "./office/config.ts";
import { allowsOfficeEdit } from "./office/edit-policy.ts";
import { WopiError } from "./office/errors.ts";
import { createDiscoveryCache } from "./office/protocol/discovery-cache.ts";
import { applyOfficeStorageEvent, withOfficeMetadata } from "./office/registry-events.ts";
import { registerOfficeRoutes, registerWopiRoutes } from "./office/routes.ts";
import { createOfficeService } from "./office/service.ts";
import {
  createOfficeSettingsService,
  OFFICE_SETTINGS_KEY,
  probeOnlyOfficeRuntime,
} from "./office/settings.ts";
import { registerOfficeSettingsRoutes } from "./office/settings-routes.ts";
import { createOfficeStorageFactory } from "./office/storage.ts";
import { createOfficeTokenCodec } from "./office/tokens.ts";
import type { OfficeDeps } from "./office/types.ts";
import { registerProviderRoutes } from "./providers/routes.js";
import { createProviderService, hostLabel } from "./providers/service.js";
import { createSettingsMountMappingStore } from "./scoping/mount-mapping-store.ts";
import { createSettingsScopeOverrideStore } from "./scoping/override-store.ts";
import { createReadAuthorizer } from "./scoping/read-authorizer.ts";
import { createScopeResolver } from "./scoping/resolver.ts";
import { registerScopeRoutes } from "./scoping/routes.ts";
import { createScopeSuggester } from "./scoping/suggest.ts";
import { createEmbedClient } from "./search/embeddings.js";
import { createImageEmbedClient } from "./search/image-embed-client.js";
import { createImageSearchService } from "./search/image-service.js";
import { parseSearchLimit, registerSearchRoutes } from "./search/routes.js";
import { createSearchService } from "./search/service.js";
import { registerSetupRoutes } from "./setup/routes.js";
import { createSetupService } from "./setup/service.js";
import { createSetupTokenGuard, generateSetupToken } from "./setup/token.js";
import { createShareCredentialCodec } from "./shares/credentials.ts";
import { createShareLimiter } from "./shares/limiter.ts";
import { registerSharesRoutes } from "./shares/routes.ts";
import { createSharesService } from "./shares/service.ts";
import { createCachedProbe } from "./system/cached-probe.js";
import { fetchEmbedStatus } from "./system/embed-status.js";
import { createSystemEventLog } from "./system/event-log.js";
import { createIndexerClient, type IndexerClient } from "./system/indexer-client.js";
import { createOcrClient } from "./system/ocr-client.js";
import { createPublicUrlService } from "./system/public-url.js";
import { registerPublicUrlRoutes } from "./system/public-url-routes.js";
import { registerSystemRoutes } from "./system/routes.js";
import { fetchRuntimeStatus, runtimeFailure } from "./system/runtime-status.js";
import { createThumbnailsRepo } from "./system/thumbnails-repo.js";
import { registerThumbRoutes } from "./thumbs/routes.js";
import { createResolveTokenPrincipal } from "./tokens/principal.js";
import { registerTokenRoutes } from "./tokens/routes.js";
import { createTokenService } from "./tokens/service.js";
import { registerTrashRoutes } from "./trash/routes.js";
import { createTrashSettingsService } from "./trash/settings.js";
import { registerTrashSettingsRoutes } from "./trash/settings-routes.js";

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
 * provider service (rows in `app.providers`, seeded from `SFTPGO_URL`, see
 * `src/providers/service.ts`), the event bus, the login rate limiter, the
 * auth module, the setup module (logging the one-time setup token while
 * setup is required), the admin provider routes, and the fs and events
 * route groups. Returns the resulting `Hono` app plus a `close` that ends
 * the database pool.
 */
export async function composeApp(
  config: AppConfig,
  logger: Logger,
  clock: () => Date = () => new Date(),
  deps: ComposeAppDeps = {},
): Promise<ComposedApp> {
  // A misconfigured fdrive must say what is missing, by variable name, at
  // startup: see docs/INDEXER.md. One line per
  // subsystem, logged before anything else touches the network.
  for (const line of startupSummaryLines(config)) {
    logger.info(line);
  }

  const master = parseMasterKey(config.fdriveMasterKey);

  const { db, pool } = createDb(config.databaseUrl, {
    onError: (error) => logger.warn({ err: error }, "idle database connection error"),
  });
  if (config.fdriveAutoMigrate) {
    await migrate(db);
  }
  const repos = createRepos(db);
  const eventLog = createSystemEventLog({ repo: repos.systemEvents, logger });

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const trashSettings = createTrashSettingsService({
    settings: repos.settings,
    identities: repos.identities,
    // The provider service below reads these settings back (`trashEnabled`);
    // the strategy lookup runs per request, after both exist.
    strategyFor: async (providerId) =>
      (await providerService.get(providerId))?.module.trash ?? "none",
  });
  // Storage providers are rows: the SFTPGo named by `SFTPGO_URL` is seeded
  // and pinned at startup. Every credential-bearing call resolves an
  // identity's own row first, so nothing ever follows a configuration
  // change to another server.
  const providerService = createProviderService({
    repos,
    fetch: fetchImpl,
    clock,
    eventLog,
    environment: {
      sftpgoUrl: config.sftpgoUrl,
      homeTemplate: config.fdriveHomeTemplate,
      indexRootNames: (config.fdriveIndexRoots ?? []).map((root) => root.name),
    },
    trashEnabled: async (providerId) => (await trashSettings.configuration(providerId)).enabled,
  });
  await providerService.seedFromEnvironment();

  const featureService = createFeatureService({
    settings: repos.settings,
    config,
    fetch: fetchImpl,
    eventLog,
  });
  const featureValues = async () => (await featureService.configuration()).values;

  const bus = createEventBus();
  const jobRunner = createJobRunner({ clock, bus });
  const limiter = createLoginLimiter({ clock });
  const tokenSource = createTokenSource({
    repos,
    providers: providerService,
    master,
    clock,
    fetch: fetchImpl,
  });
  // The address everyone opens fdrive at, chosen in onboarding. Deployments
  // from before it was a setting of its own stored it as Office's `appUrl`;
  // that value stays in force until the owner saves the address here.
  const publicUrl = createPublicUrlService({
    settings: repos.settings,
    legacyUrl: async () => {
      const stored = await repos.settings.get<{ appUrl?: unknown }>(OFFICE_SETTINGS_KEY);
      return typeof stored?.appUrl === "string" ? stored.appUrl : null;
    },
  });

  const storageFactory = createIdentityStorageFactory({
    providers: providerService,
    tokenSource,
    fetch: fetchImpl,
    clock,
    resolveTrashSettings: (identityId) => trashSettings.forIdentity(identityId),
  });
  const pinnedStorageFactory = createPinnedStorageFactory({
    providers: providerService,
    tokenSource,
    fetch: fetchImpl,
  });
  const identityLinks = createIdentityLinksRepo(db);
  const auth = createAuthModule({
    identityLinks,
    repos,
    providers: providerService,
    fetch: fetchImpl,
    master,
    clock,
    config,
    limiter,
    tokenSource,
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
  // `docs/SCOPING.md`.
  const scopeResolver = createScopeResolver({
    providers: repos.providers,
    overrides: createSettingsScopeOverrideStore(repos.settings),
    mountMappings: createSettingsMountMappingStore(repos.settings),
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
  // Proposes physical locations for unmapped virtual folders from index rows
  // (`docs/SCOPING.md`); administrators confirm them.
  const scopeSuggester = createScopeSuggester({
    resolver: scopeResolver,
    storageForIdentity: (identity) => storageFactory(identity.id),
    indexer: scopeIndexerDirectory,
    indexQueries,
    indexRoots: config.fdriveIndexRoots,
  });
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
    clock,
  });

  const accountStorage = createOfficeStorageFactory({ pinned: pinnedStorageFactory });
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
    providers: providerService,
    fetch: fetchImpl,
    limiter,
    master,
    clock,
    storageForIdentity: identityStorageForAccount,
    searchForIdentity: async (identity, query) => {
      const current = await repos.identities.get(identity.id);
      if (current?.accountId !== identity.accountId)
        throw new ApiHttpError("forbidden", "identity ownership changed");
      const verified = await scopeResolver.verifiedIndexScopes(identity);
      const storage = await identityStorageForAccount(identity);
      return searchService.search({
        trashPath: await trashSettings.pathForIdentity(identity.id),
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
  const officeProduct = configuredOfficeProduct(config);
  const officeDiscoveries = new Map<string, ReturnType<typeof createDiscoveryCache>>();
  /** Only the compose-bundled ONLYOFFICE image runs a controller with a `/runtime` status document. */
  const isBundledOfficeController = (resolved: { product: string; serverUrl: string }): boolean => {
    const server = new URL(resolved.serverUrl);
    return (
      resolved.product === "onlyoffice" &&
      server.protocol === "http:" &&
      server.hostname === "onlyoffice" &&
      (server.port === "" || server.port === "80")
    );
  };
  const officeRuntimeFor = async (configuration: {
    enabled: boolean;
  }): Promise<{
    config: ReturnType<typeof officeConfig>;
    discovery: ReturnType<typeof createDiscoveryCache>;
  } | null> => {
    if (!configuration.enabled) return null;
    const appUrl = await publicUrl.current();
    if (appUrl === null) return null;
    const resolved = officeConfig(config, appUrl);
    let discovery = officeDiscoveries.get(resolved.serverUrl);
    if (discovery === undefined) {
      discovery = createDiscoveryCache({ serverUrl: resolved.serverUrl, fetch: fetchImpl });
      officeDiscoveries.set(resolved.serverUrl, discovery);
    }
    return { config: resolved, discovery };
  };
  const officeSettings = createOfficeSettingsService({
    settings: repos.settings,
    eventLog,
    product: officeProduct,
    publicUrl: () => publicUrl.current(),
    probeStatus: async (configuration) => {
      const runtime = await officeRuntimeFor(configuration);
      if (runtime === null) return "unavailable";
      if (!isBundledOfficeController(runtime.config)) {
        await createDiscoveryCache({
          serverUrl: runtime.config.serverUrl,
          fetch: fetchImpl,
          timeoutMs: 2000,
        }).refresh();
        return "ready";
      }
      return probeOnlyOfficeRuntime(runtime.config.serverUrl, configuration.revision, fetchImpl);
    },
  });
  const resolveOfficeRuntime = async () => officeRuntimeFor(await officeSettings.configuration());
  const officeLocation: OfficeDeps["location"] = async (identity) => {
    const configured = await scopeResolver.configuredMappings(identity);
    return configured.available
      ? { providerId: configured.providerId, scopes: configured.scopes }
      : null;
  };
  /** The default (oldest enabled) provider's id, independent of any identity; used to route indexer registry events and Office settings. */
  const currentOfficeProviderId = async (): Promise<string | null> =>
    (await providerService.defaultProvider())?.id ?? null;
  const officeService = createOfficeService({
    canEdit: async (actor, path) => {
      const settings = await officeSettings.configuration();
      if (!settings.enabled || !settings.editingEnabled) return false;
      if (
        settings.editingProviderId !== actor.identity.providerId ||
        !settings.editorUsernames.includes(actor.identity.externalUsername)
      )
        return false;
      if (deps.officeCanEdit !== undefined && !(await deps.officeCanEdit(actor, path)))
        return false;
      const rules = config.fdriveOfficeEditRules ?? [];
      return rules.length === 0 || allowsOfficeEdit(rules, actor.identity, path);
    },
    config: null,
    discovery: null,
    resolveRuntime: resolveOfficeRuntime,
    tokens: createOfficeTokenCodec(master),
    repos,
    files: officeFiles,
    locks: createWopiLockRepo(db),
    withWriteScope: createOfficeWriteScope(db),
    clock,
    location: officeLocation,
    storageFactory: accountStorage,
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
    providers: providerService,
    authService: auth.service,
    accounts: repos.accounts,
    settings: repos.settings,
    hasEnvUrl: config.sftpgoUrl !== undefined,
  });

  if ((await setupService.status()).required) {
    // One-time credential: the guard invalidates it after setup, and setup cannot be
    // re-run, but the line still lands in log storage. Operators rotate logs afterwards.
    logger.warn(`setup token: ${setupToken}`);
    logger.warn("the setup token is one-time and invalidated after setup; rotate logs afterwards");
    logger.info(`open ${(await publicUrl.current()) ?? ""}/setup to finish setup`);
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
  // A worker that is down is asked one more question through its bundled
  // controller (`GET /runtime` on the controller's status port): a controller
  // that answers "failed" turns the entry from `unreachable` into `failed`
  // with the controller's fixed reason, so a worker the controller gave up
  // on is self-diagnosing from this endpoint rather than looking like a
  // network problem. The controller is only consulted when the worker itself
  // did not answer, so a healthy stack costs no extra request.
  const controllerVerdict = async (
    reachable: boolean,
    controllerUrl: string | null,
    port: string,
  ): Promise<SubsystemProbe> => {
    if (reachable || controllerUrl === null) return reachable;
    const failure = runtimeFailure(await fetchRuntimeStatus(controllerUrl, port, fetchImpl));
    return failure === null ? false : { failed: failure };
  };
  const probeSubsystems = async (
    forConfig: AppConfig,
  ): Promise<Partial<Record<Subsystem, SubsystemProbe>>> => {
    const [indexResult, searchStatus, imageSearchResult, ocrResult, officeReachable] =
      await Promise.all([
        indexerClient === null ? Promise.resolve(null) : indexerClient.health(),
        forConfig.fdriveEmbedUrl === undefined
          ? Promise.resolve(null)
          : fetchEmbedStatus({ baseUrl: forConfig.fdriveEmbedUrl, fetch: fetchImpl }),
        imageEmbedClient === null ? Promise.resolve(null) : imageEmbedClient.health(),
        ocrClient === null ? Promise.resolve(null) : ocrClient.health(),
        resolveOfficeRuntime().then((runtime) =>
          runtime === null
            ? null
            : runtime.discovery.get().then(
                () => true,
                () => false,
              ),
        ),
      ]);
    const [search, imageSearch, office] = await Promise.all([
      searchStatus === null
        ? null
        : controllerVerdict(searchStatus.healthy, forConfig.fdriveEmbedUrl ?? null, "8099"),
      // A sidecar that answered but is still loading its model is treated as
      // unreachable here: it cannot yet serve an embedding, so it is not
      // usefully "up" from the health endpoint's point of view.
      imageSearchResult === null
        ? null
        : controllerVerdict(
            imageSearchResult.ok && imageSearchResult.data.status === "ok",
            forConfig.fdriveImageEmbedUrl ?? null,
            "8013",
          ),
      officeReachable === null
        ? null
        : resolveOfficeRuntime().then((runtime) =>
            controllerVerdict(
              officeReachable,
              runtime !== null && isBundledOfficeController(runtime.config)
                ? runtime.config.serverUrl
                : null,
              "8099",
            ),
          ),
    ]);
    return {
      ...(indexResult === null ? {} : { index: indexResult.ok }),
      ...(search === null ? {} : { search }),
      ...(imageSearch === null ? {} : { imageSearch }),
      ...(ocrResult === null ? {} : { ocr: ocrResult.ok }),
      ...(office === null ? {} : { office }),
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
      const configuredProviderTypes = (await providerService.list()).map((p) => p.type);
      if (setup.required) return { required: true, providers: [], configuredProviderTypes };
      return {
        required: false,
        configuredProviderTypes,
        providers: (await providerService.enabled()).map((provider) => ({
          type: provider.type,
          host: hostLabel(provider.baseUrl),
        })),
      };
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
          providers: providerService,
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
      registerScopeRoutes(groups, {
        resolver: scopeResolver,
        identities: repos.identities,
        suggester: scopeSuggester,
      });
      registerSetupRoutes(groups, {
        service: setupService,
        tokenGuard: setupTokenGuard,
        limiter,
        config,
      });
      registerProviderRoutes(groups, { service: providerService });
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
        trashPathForStorage: (storage: StorageProvider) => {
          const settings = trashSettingsForStorage(storage);
          return settings?.enabled === true ? settings.path : null;
        },
        folderSize: {
          indexQueries,
          resolver: scopeResolver,
          identities: repos.identities,
          trashPathForStorage: (storage: StorageProvider) => {
            const settings = trashSettingsForStorage(storage);
            return settings?.enabled === true ? settings.path : null;
          },
        },
      };
      registerFsRoutes(groups, fsRoutesDeps);
      registerTrashRoutes(groups, {
        bus,
        clock,
        settingsForStorage: trashSettingsForStorage,
        metadata: fsMetadata,
      });
      registerTrashSettingsRoutes(groups, {
        service: trashSettings,
        identities: repos.identities,
      });
      registerPublicUrlRoutes(groups, { service: publicUrl });
      registerOfficeSettingsRoutes(groups, {
        service: officeSettings,
        workerToken: config.fdriveWorkerToken,
        activeProviderId: currentOfficeProviderId,
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
        trashPathForStorage: (storage) => {
          const settings = trashSettingsForStorage(storage);
          return settings?.enabled === true ? settings.path : null;
        },
      });
      registerThumbRoutes(groups, {
        enabled: async () =>
          (await featureService.enabled("thumbnails")) ||
          (await featureService.enabled("imageSearch")),
        indexQueries,
        resolver: scopeResolver,
        identities: repos.identities,
        thumbsDir: config.fdriveThumbsDir,
      });
      registerSystemRoutes(groups, {
        settings: repos.settings,
        systemEvents: repos.systemEvents,
        eventLog,
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
  // guarded, and `authenticateMcpRequest` never touches the session cookie.
  // Its failed-authentication limiter is its own instance, so a flood of
  // anonymous MCP attempts cannot exhaust the capacity login and setup
  // share, or the other way round.
  registerMcpRoutes(app, {
    resolveToken: resolveTokenPrincipal,
    limiter: createLoginLimiter({ clock }),
    clientIp: (c) => extractClientIp(c, config.fdriveTrustedProxyHops),
    toolDeps: {
      indexQueries,
      searchService,
      scopeResolver,
      identities: repos.identities,
      publicUrl: () => publicUrl.current(),
      indexerClient: indexerExtractClient,
      writesEnabled: config.fdriveMcpWrites,
      metadata: metadataService,
      imageSearchService,
      onMutation: async (principal, change) => {
        try {
          if (change.kind === "move" || (change.kind === "restore" && change.moveMetadata)) {
            await fsMetadata.onMoved(
              principal.identityId,
              change.path,
              change.target ?? change.path,
              change.isDir,
            );
          } else if (change.kind === "trash") {
            await fsMetadata.onTrashed(principal.identityId, change.path, change.isDir);
          } else if (change.kind === "copy") {
            fsMetadata.onCopied(principal.identityId, change.path, change.target ?? change.path);
          }
        } finally {
          const kind =
            change.kind === "trash" ? "delete" : change.kind === "restore" ? "move" : change.kind;
          publishFsEvent(
            { bus, clock },
            principal,
            kind,
            [change.eventPath ?? change.path],
            change.target === undefined ? undefined : [change.target],
          );
        }
      },
      clock,
      trashPathForStorage: (storage) => {
        const settings = trashSettingsForStorage(storage);
        return settings?.enabled === true ? settings.path : null;
      },
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
