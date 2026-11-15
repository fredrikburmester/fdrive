import { withBackupWriter } from "@fdrive/backup";
import { reservedFolders, type StorageProvider } from "@fdrive/core";
import {
  createActivityExportsRepo,
  createActivityObservationsRepo,
  createActivityReadsRepo,
  createActivityRepo,
  createChangeJournal,
  createChangeWriter,
  createDb,
  createDesktopRepo,
  createFilesFolderFacts,
  createIndexQueries,
  createOfficeFileRepo,
  createOfficeWriteScope,
  createProcessingFailureReader,
  createRepos,
  createShareRepo,
  createWopiLockRepo,
  type DesktopAccessMove,
  migrate,
} from "@fdrive/db";
import { SHARED_WITH_ME } from "@fdrive/local";
import type { Logger } from "pino";
import { createActivityAdmission } from "./activity/admission.ts";
import { registerActivityExports } from "./activity/exports.ts";
import { createActivityMaintenance } from "./activity/maintenance.ts";
import { createActivityObservations } from "./activity/observations.ts";
import { registerPersonalActivityRoutes } from "./activity/routes.ts";
import { createActivityService } from "./activity/service.ts";
import { createChatService } from "./ai/chat/service.ts";
import { createOrganizeRuns } from "./ai/organize/runs.ts";
import { createOrganizeService } from "./ai/organize/service.ts";
import { createAiModel } from "./ai/provider.ts";
import { registerAiRoutes } from "./ai/routes.ts";
import { createAiSettingsService, type ResolvedAiConfig } from "./ai/settings.ts";
import type { AppHono } from "./app.js";
import { createApp } from "./app.js";
import {
  createAuthModule,
  createLoginLimiter,
  createLoginReauthentication,
  createPasswordCheck,
  open,
  parseMasterKey,
  seal,
} from "./auth/index.js";
import { createPrincipalFactory } from "./auth/principal.ts";
import { createIdentityStorageFactory, trashSettingsForStorage } from "./auth/storage-factory.ts";
import { createBackupModule } from "./backups/module.js";
import { createRecoveryApp } from "./backups/recovery.js";
import { registerBackupRoutes } from "./backups/routes.js";
import type { AppConfig } from "./config.js";
import { type Subsystem, type SubsystemProbe, startupSummaryLines } from "./config-keys.js";
import { createDesktopChanges } from "./desktop/changes.js";
import { createIndexedContentLookup } from "./desktop/indexed-content.js";
import { withDesktopMetadata } from "./desktop/metadata.js";
import { createDesktopRetention } from "./desktop/retention.js";
import { registerDesktopRoutes } from "./desktop/routes.js";
import { createDesktopWrites } from "./desktop/writes.js";
import { ApiHttpError } from "./errors.js";
import { createEventBus } from "./events/bus.js";
import { createIndexerListener, createPgNotificationClient } from "./events/indexer-listener.js";
import { registerEventRoutes } from "./events/routes.js";
import { registerFeatureAdmission } from "./features/admission.js";
import { registerFeatureRoutes } from "./features/routes.js";
import { createFeatureService } from "./features/service.js";
import { publishFsEvent, registerFsRoutes } from "./fs/routes.js";
import { createJobRunner } from "./jobs/runner.js";
import { createChangeQueue } from "./local/change-queue.js";
import {
  createDeploymentFilesFolderGuard,
  deploymentFilesFolder,
  ensureStorageRow,
  filesFolderHealth,
  journalRoot,
  localIndexRoot,
} from "./local/files-folder.js";
import { registerGrantRoutes } from "./local/grant-routes.js";
import { createLocalGrantService } from "./local/grants.js";
import { registerLocalUserRoutes } from "./local/routes.js";
import { createLocalUserService } from "./local/service.js";
import { createLocalUserStore } from "./local/users.js";
import type { McpToolDeps } from "./mcp/handlers.js";
import { createIndexerExtractClient } from "./mcp/indexer-client.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { registerMetadataRoutes } from "./metadata/routes.js";
import { createMetadataService, withFollowers } from "./metadata/service.js";
import { withTrashMoves } from "./metadata/trash-moves.js";
import { extractClientIp } from "./net.js";
import { configuredOfficeProduct, officeConfig } from "./office/config.ts";
import { allowsOfficeEdit } from "./office/edit-policy.ts";
import { createDiscoveryCache } from "./office/protocol/discovery-cache.ts";
import { applyOfficeRootEvent, withOfficeMetadata } from "./office/registry-events.ts";
import { registerOfficeRoutes, registerWopiRoutes } from "./office/routes.ts";
import { createOfficeService } from "./office/service.ts";
import { createOfficeSettingsService, probeOnlyOfficeRuntime } from "./office/settings.ts";
import { registerOfficeSettingsRoutes } from "./office/settings-routes.ts";
import { createOfficeStorageFactory } from "./office/storage.ts";
import { createOfficeTokenCodec } from "./office/tokens.ts";
import type { OfficeDeps } from "./office/types.ts";
import { createScopeResolver } from "./scoping/resolver.ts";
import { createEmbedClient } from "./search/embeddings.js";
import { createImageEmbedClient } from "./search/image-embed-client.js";
import { createImageSearchService } from "./search/image-service.js";
import { createNameIndexClient } from "./search/name-index.js";
import { registerSearchRoutes } from "./search/routes.js";
import { withCachedRootIds } from "./search/scopes.ts";
import { createSearchService } from "./search/service.js";
import { registerSetupRoutes } from "./setup/routes.js";
import { createSetupService } from "./setup/service.js";
import { createSetupTokenGuard, generateSetupToken } from "./setup/token.js";
import { createShareCredentialCodec } from "./shares/credentials.ts";
import { createShareLimiter } from "./shares/limiter.ts";
import { createShareMoves } from "./shares/moves.ts";
import { createScryptSharePasswords } from "./shares/passwords.js";
import { registerSharesRoutes } from "./shares/routes.ts";
import { createSharesService } from "./shares/service.ts";
import { registerActivityRoutes } from "./system/activity.js";
import { createCachedProbe } from "./system/cached-probe.js";
import { fetchEmbedStatus } from "./system/embed-status.js";
import { createSystemEventLog } from "./system/event-log.js";
import { createIndexerClient } from "./system/indexer-client.js";
import { createOcrClient } from "./system/ocr-client.js";
import { registerProcessingFailureRoutes } from "./system/processing-failures.js";
import { createPublicUrlService } from "./system/public-url.js";
import { registerPublicUrlRoutes } from "./system/public-url-routes.js";
import { registerSystemRoutes } from "./system/routes.js";
import { fetchRuntimeStatus, runtimeFailure } from "./system/runtime-status.js";
import { createStorageService } from "./system/storage.js";
import { registerStorageRoutes } from "./system/storage-routes.js";
import { createThumbnailsRepo } from "./system/thumbnails-repo.js";
import { registerThumbRoutes } from "./thumbs/routes.js";
import { createResolveTokenPrincipal } from "./tokens/principal.js";
import { registerTokenRoutes } from "./tokens/routes.js";
import { createTokenService } from "./tokens/service.js";
import { registerTrashRoutes } from "./trash/routes.js";
import { createTrashSettingsService } from "./trash/settings.js";
import { registerTrashSettingsRoutes } from "./trash/settings-routes.js";
import { readBuild } from "./version.js";

export interface ComposeAppDeps {
  /** Explicit server-side admission override for isolated integration fixtures. */
  readonly officeCanEdit?: OfficeDeps["canEdit"];
}

export interface ComposedApp {
  readonly app: AppHono;
  close(): Promise<void>;
}

/** How long one `/health` sidecar reachability fan-out is reused; see `createCachedProbe`. */
const HEALTH_PROBE_TTL_MS = 15_000;

/**
 * Wires every fdrive API dependency together: the Postgres pool and repos
 * (running pending migrations first), the files folder (`FDRIVE_STORAGE_ROOT`)
 * and its row in `app.providers`, the event bus, the login rate limiter, the
 * auth module, the setup module (logging the one-time setup token while
 * setup is required), and every route group. Returns the resulting `Hono`
 * app plus a `close` that ends the database pool.
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
  await migrate(db);
  const repos = createRepos(db);
  const restored = await repos.settings.get("backup.restore.v1");
  if (config.fdriveRestoreMode || restored) return createRecoveryApp(config, pool, !!restored);
  const passwords = createScryptSharePasswords();
  // Changes fdrive makes go to the change journal, so the indexer hears of
  // them at once instead of at its next scan.
  const changes = createChangeQueue({
    write: createChangeWriter(db, "api"),
    onError: (error) =>
      logger.warn(
        { err: error },
        "change not journaled; the indexer's watcher or scan will find it",
      ),
  });
  // A wrong or empty files folder is refused, not served or read as every
  // file deleted; the verdict is logged once and checked again as it ages.
  const guard = createDeploymentFilesFolderGuard(
    config.fdriveStorageRoot,
    createFilesFolderFacts(db),
    {
      info: (message) => logger.info(message),
      error: (message) => logger.error(message),
    },
  );
  await guard.verify();
  /** The files folder's row in `app.providers`: Trash settings, Office and the Mac name it. */
  const storageId = await ensureStorageRow(repos);
  /**
   * Folders in each user's files no share reaches (`reservedFolders`): their
   * Trash while it is on and the Mac's bookkeeping, which holds its Trash.
   * Read per request, like the rest of Trash; `trashSettings` exists by the
   * time it is asked.
   */
  const closedFolders = async (): Promise<readonly string[]> => {
    const settings = await trashSettings.configuration(storageId);
    return reservedFolders(settings.enabled ? settings.path : null);
  };
  const folder = deploymentFilesFolder(config, repos, { changes, guard, closedFolders });
  const backups = createBackupModule(config, { storageId, folder });
  await backups.start();

  const activityPathLocks = createDb(config.databaseUrl, {
    max: 10,
    connectionTimeoutMillis: 30_000,
    onError: (error) => logger.warn({ err: error }, "idle activity lock connection error"),
  });
  const activityRepo = createActivityRepo(db, clock, activityPathLocks.db);
  const activityReads = createActivityReadsRepo(db, clock);
  const personalActivity = createActivityService({
    repo: activityRepo,
    clock,
    pending: (operationId) =>
      logger.warn({ operationId }, "personal activity outcome pending recovery"),
  });

  const activityMaintenance = createActivityMaintenance({
    repo: activityRepo,
    reads: activityReads,
    clock,
    onError: (error) => logger.warn({ err: error }, "personal activity maintenance pending"),
  });

  const eventLog = createSystemEventLog({ repo: repos.systemEvents, logger });

  const fetchImpl = globalThis.fetch;
  const trashSettings = createTrashSettingsService({
    settings: repos.settings,
    identities: repos.identities,
  });
  const storage = createStorageService({ storageId, settings: repos.settings, folder, eventLog });
  const indexRootNames = new Set((config.fdriveIndexRoots ?? []).map((root) => root.name));
  /** The index root the files folder is read under; indexed only when it is configured. */
  const rootName = localIndexRoot(config.fdriveIndexRoots, config.fdriveStorageRoot);
  /** The same for every login: the storage's name, whether Trash is on, and indexing. */
  const installation = async () => ({
    storageName: await storage.name(),
    trash: (await trashSettings.configuration(storageId)).enabled,
    index: indexRootNames.has(rootName),
  });
  const localUserStore = createLocalUserStore({
    repo: repos.localUsers,
    grants: repos.localGrants,
    passwords,
  });
  // One limiter for every password check and setup, so failures anywhere count everywhere.
  const limiter = createLoginLimiter({ clock });
  const checkPassword = createPasswordCheck({ limiter, users: localUserStore });
  const localUsers = createLocalUserService({
    repos,
    checkPassword,
    passwords,
    clock,
    storageId,
    eventLog,
  });

  const featureService = createFeatureService({
    probeCacheMs: 2000,
    settings: repos.settings,
    config,
    fetch: fetchImpl,
    eventLog,
  });
  const featureValues = async () => (await featureService.configuration()).values;

  const bus = createEventBus();
  const jobRunner = createJobRunner({ clock, bus });
  // The address everyone opens fdrive at, chosen in onboarding. Until it is
  // saved, Office cannot be enabled and MCP links are paths on this origin.
  const publicUrl = createPublicUrlService({ settings: repos.settings });

  /** The installation's Trash settings, kept in memory by their service. */
  const currentTrash = () => trashSettings.configuration(storageId);
  const storageFactory = createIdentityStorageFactory({
    identities: repos.identities,
    folder,
    clock,
    resolveTrashSettings: currentTrash,
  });
  // A signed-in request's principal: its session or token query already
  // read the login and admitted its user, so its storage needs no query.
  const principalFor = createPrincipalFactory({ folder, clock, trashSettings: currentTrash });
  // Without Trash settings: deletes are real. For fdrive's own bookkeeping
  // (the Mac's staged files) and Office, which only saves over documents.
  const storageWithoutTrash = createIdentityStorageFactory({
    identities: repos.identities,
    folder,
    clock,
  });
  const shareRepo = createShareRepo(db);
  const admitActivity = createActivityAdmission({
    reads: activityReads,
    repo: activityRepo,
    secret: config.fdriveMasterKey,
    clock,
    shares: shareRepo,
  });
  const auth = createAuthModule({
    repos,
    clock,
    config,
    checkPassword,
    principalFor,
    installation,
  });

  // The System pages' client for the indexer's internal HTTP API; `null`
  // when `FDRIVE_INDEXER_URL` is not configured.
  const indexerClient =
    config.fdriveIndexerUrl === undefined
      ? null
      : createIndexerClient({ baseUrl: config.fdriveIndexerUrl, fetch: fetchImpl });

  // The single source of truth for what every identity may read from the
  // index: each login's home is `<root>/<username>` on its provider's index
  // root, and index-backed features get it only when that root is indexed.
  // See `docs/SCOPING.md`.
  const localGrants = createLocalGrantService({
    repos,
    storageId,
    storageFor: storageFactory,
    trashPathFor: (identityId) => trashSettings.pathForIdentity(identityId),
    closedFolders,
  });
  const scopeResolver = createScopeResolver({
    storageId,
    rootName,
    indexRootNames,
    // Folders others share with a local login are indexed where their owner
    // keeps them; the login sees them under `Shared with me`.
    extraScopes: async (username, home) =>
      (await localGrants.received(username)).map((folder) => ({
        rootName: home.rootName,
        fsPrefix: `/${folder.owner}${folder.path === "/" ? "" : folder.path}`,
        virtualPrefix: `/${SHARED_WITH_ME}/${folder.name}`,
      })),
  });

  // Search: available only once at least one index root is configured
  // (`FDRIVE_INDEX_ROOTS`); the search route itself degrades to
  // `{ unavailable: true }` rather than erroring when the caller's
  // verified index scopes are unavailable for any reason.
  const indexQueries = withCachedRootIds(createIndexQueries(db), indexRootNames);
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
    nameIndex:
      config.fdriveIndexerUrl === undefined
        ? null
        : createNameIndexClient({ baseUrl: config.fdriveIndexerUrl, fetch: fetchImpl }),
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

  const officeStorage = createOfficeStorageFactory({ storageId, storage: storageWithoutTrash });

  // Public links follow the items they name wherever they go, into Trash too.
  const shareMoves = createShareMoves({
    shares: shareRepo,
    ownerPath: (identityId, path) => localGrants.ownerPath(identityId, path),
  });
  // Metadata (phase 3): tags, favorites, recents. `onMoved`/`onDeleted` are
  // called both from the fs routes below (moves and deletes made through
  // fdrive) and from the indexer listener (changes seen over SFTP or any
  // other client), so metadata survives renames from either source.
  const metadataCore = createMetadataService(repos);
  // What grants access (folders shared with people, public links) follows
  // first, in an outer layer, so a failure in tags or favorites never leaves
  // it at a path a new item could take.
  const accessFollowers = [localGrants, shareMoves];
  /** A login's Trash folder while Trash is on; none for a login removed since. */
  const trashPathOf = async (identityId: string): Promise<string | null> => {
    try {
      return await trashSettings.pathForIdentity(identityId);
    } catch (error) {
      if (error instanceof ApiHttpError && error.kind === "unauthorized") return null;
      throw error;
    }
  };
  // A move into the Trash, whoever reports it, leaves metadata where the item was.
  const metadataService = withFollowers(withTrashMoves(metadataCore, trashPathOf), accessFollowers);
  const desktopRepo = createDesktopRepo(db);
  const desktopRetention = createDesktopRetention({
    repo: desktopRepo,
    // Without Trash settings, so the Mac's staged files are deleted rather
    // than moved into the Trash their owner sees.
    storageForIdentity: storageWithoutTrash,
    clock,
    eventLog,
  });
  const officeFiles = createOfficeFileRepo(db);
  const withOffice = (metadata: typeof metadataCore) =>
    withOfficeMetadata(
      metadata,
      officeFiles,
      repos.identities,
      scopeResolver.configuredMappings,
      clock,
    );
  const fsMetadata = withFollowers(
    withTrashMoves(withOffice(withDesktopMetadata(metadataCore, desktopRepo)), trashPathOf),
    accessFollowers,
  );
  // A Mac write moves what grants access with its receipt (`desktop/writes.ts`)
  // and the rest after it. It keeps its own item handles, so this skips the
  // handle registry, whose `onTrashed` would retire the handle of an item the
  // Mac puts in its own Trash.
  const desktopMetadata = withTrashMoves(withOffice(metadataCore), trashPathOf);
  const desktopAccess = async (
    identityId: string,
    from: string,
    to: string,
    directory: boolean,
  ): Promise<DesktopAccessMove | null> => {
    const shares = await shareMoves.resolve(identityId, from, to);
    const grants = await localGrants.grantMove(identityId, from, to, directory);
    return shares === null && grants === null ? null : { directory, shares, grants };
  };
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
    probeCacheMs: 2000,
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
  /** The files folder's row and name, which editor grants bind to. */
  const currentOfficeProvider = async () => ({ id: storageId, label: await storage.name() });
  // Office's document locks on a pool of their own: a save holds its document's
  // lock, and a connection, while its body arrives, and checks admission and
  // records history on the main pool meanwhile. Nothing on the main pool waits
  // for these locks, so a saturated pool lengthens a save but cannot deadlock.
  const officeLocks = createDb(config.databaseUrl, {
    max: 10,
    connectionTimeoutMillis: 30_000,
    onError: (error) => logger.warn({ err: error }, "idle office lock connection error"),
  });
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
      // A folder shared to view only opens for viewing, never for an edit that cannot save.
      if (await localGrants.isReadOnly(actor.identity.externalUsername, path)) return false;
      const rules = config.fdriveOfficeEditRules ?? [];
      return rules.length === 0 || allowsOfficeEdit(rules, actor.identity, path);
    },
    config: null,
    discovery: null,
    resolveRuntime: resolveOfficeRuntime,
    tokens: createOfficeTokenCodec(master),
    repos,
    files: officeFiles,
    locks: createWopiLockRepo(officeLocks.db),
    withWriteScope: createOfficeWriteScope(officeLocks.db),
    clock,
    location: officeLocation,
    storageFactory: officeStorage,
    metadata: metadataService,
    bus,
    activity: personalActivity,
  });

  // The indexer's `LISTEN idx_events` connection only has anything to listen
  // for once at least one index root is configured; it is otherwise left
  // unstarted so a deployment without an indexer never opens a spare
  // Postgres connection.
  // The indexer's notifications are the only way personal activity notices a
  // change made outside fdrive.
  const activityObservations = createActivityObservations({
    repo: createActivityObservationsRepo(db, clock),
    identities: repos.identities,
    storageFactory,
    resolver: scopeResolver,
  });
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
          onStorageEvent: (event) =>
            applyOfficeRootEvent(officeFiles, { id: storageId, rootName }, event),
          onActivityEvent: activityObservations.watcher,
          activityTracks: activityObservations.tracks,
          onActivityRelink: activityObservations.relink,
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

  const tokenService = createTokenService({ apiTokens: repos.apiTokens, clock });
  const resolveTokenPrincipal = createResolveTokenPrincipal({
    apiTokens: repos.apiTokens,
    logins: repos.logins,
    clock,
    principalFor,
  });
  // The MCP `read_file_text` tool talks to the indexer's `POST /extract-content`
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
    authService: auth.service,
    logins: repos.logins,
    passwords,
    clock,
    storageId,
  });

  if ((await setupService.status()).required) {
    // One-time credential: the guard invalidates it after setup, and setup cannot be
    // re-run, but the line still lands in log storage. Operators rotate logs afterwards.
    logger.warn(`setup token: ${setupToken}`);
    logger.warn("the setup token is one-time and invalidated after setup; rotate logs afterwards");
    logger.info(`open ${(await publicUrl.current()) ?? ""}/setup to finish setup`);
  }

  let setupDone = false;
  const build = readBuild();
  const startedAt = clock();

  // GET /api/v1/health's `subsystems` field: reuses each sidecar's existing
  // liveness probe (the same ones the System pages already poll), so a
  // subsystem that is configured but unreachable is visible from this
  // public, unauthenticated endpoint too, not only from an admin session.
  // The fan-out is cached for HEALTH_PROBE_TTL_MS and shared between
  // concurrent requests, so anonymous health polling cannot be turned into
  // load at the sidecars.
  // A worker that is down is asked one more question through its status
  // document (`GET /runtime` below a unit of the ml service, or on the Office
  // controller's status port): an answer of "failed" turns the entry from
  // `unreachable` into `failed` with the document's fixed reason, so a worker
  // that gave up starting is self-diagnosing from this endpoint rather than
  // looking like a network problem. The document is only consulted when the
  // worker itself did not answer, so a healthy stack costs no extra request.
  const controllerVerdict = async (
    reachable: boolean,
    controllerUrl: string | null,
    port: string | null,
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
        : controllerVerdict(
            searchStatus.healthy,
            forConfig.fdriveEmbedRuntimeUrl ?? forConfig.fdriveEmbedUrl ?? null,
            null,
          ),
      // A sidecar that answered but is still loading its model is treated as
      // unreachable here: it cannot yet serve an embedding, so it is not
      // usefully "up" from the health endpoint's point of view.
      imageSearchResult === null
        ? null
        : controllerVerdict(
            imageSearchResult.ok && imageSearchResult.data.status === "ok",
            forConfig.fdriveImageEmbedRuntimeUrl ?? forConfig.fdriveImageEmbedUrl ?? null,
            null,
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
      core: await filesFolderHealth(guard),
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

  const mcpToolDeps: McpToolDeps = {
    activity: personalActivity,
    activityReads,
    indexQueries,
    searchService,
    scopeResolver,
    publicUrl: () => publicUrl.current(),
    indexerClient: indexerExtractClient,
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
        }
        if (change.kind === "restore" && change.eventPath !== undefined) {
          // A restore is a move out of Trash: shares that followed the item there come back.
          await fsMetadata.onMoved(
            principal.identityId,
            change.eventPath,
            change.target ?? change.path,
            change.isDir,
          );
        } else if (change.kind === "trash") {
          await fsMetadata.onTrashed(
            principal.identityId,
            change.path,
            change.isDir,
            change.trashLeaf ?? null,
          );
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
  };
  const aiSettings = createAiSettingsService({
    settings: repos.settings,
    secrets: {
      seal: (bytes, context) => seal(master, bytes, context),
      open: (bytes, context) => open(master, bytes, context),
    },
    eventLog,
  });
  const aiModelFor = (aiConfig: ResolvedAiConfig) => createAiModel(aiConfig, { fetch: fetchImpl });
  const organizeService = createOrganizeService({
    settings: aiSettings,
    modelFor: aiModelFor,
    runs: createOrganizeRuns({
      clock,
      onUnexpectedError: (error) => logger.warn({ err: error }, "organize run failed"),
    }),
    mcp: mcpToolDeps,
  });
  const chatService = createChatService({
    settings: aiSettings,
    modelFor: aiModelFor,
    chats: repos.aiChats,
    mcp: mcpToolDeps,
    fs: {
      bus,
      clock,
      metadata: metadataService,
      activity: personalActivity,
      trashPathForStorage: (storage) => {
        const settings = trashSettingsForStorage(storage);
        return settings?.enabled === true ? settings.path : null;
      },
    },
    clock,
    onUnexpectedError: (error) => logger.warn({ err: error }, "chat reply failed"),
  });

  const app = createApp({
    ...(config.fdriveBackupStateDir
      ? {
          requestGate: async (path: string, method: string, work: () => Promise<void>) => {
            if (
              ["GET", "HEAD", "OPTIONS"].includes(method) ||
              path.includes("/system/backups") ||
              path.includes("/setup/") ||
              path.includes("/health") ||
              path.includes("/about") ||
              path.includes("/internal/")
            )
              return work();
            await withBackupWriter(backups.gatePool, work);
          },
        }
      : {}),
    config,
    logger,
    clock,
    version: build.version,
    release: build.release,
    revision: build.revision,
    startedAt,
    subsystemReachability,
    principalResolver: auth.principalResolver,
    // Setup never reopens once it is done, so that answer is kept.
    setupRequired: async () => {
      if (setupDone) return false;
      setupDone = !(await setupService.status()).required;
      return !setupDone;
    },
    registerRoutes: (groups) => {
      registerBackupRoutes(
        groups,
        backups,
        createLoginReauthentication({ identities: repos.identities, checkPassword }),
        config.fdriveTrustedProxyHops,
      );
      registerFeatureAdmission(groups.authed, featureService);
      registerFeatureRoutes(groups, {
        service: featureService,
        workerToken: config.fdriveWorkerToken,
      });
      auth.registerRoutes(groups);
      // Version checks answer from the index where its row provably describes the file.
      const desktopIndexedContent = createIndexedContentLookup({
        resolver: scopeResolver,
        index: indexQueries,
      });
      // The change journal has this API's own changes only for the root it
      // journals under; a location's feed needs every one of its roots there.
      const journaled = journalRoot(config.fdriveIndexRoots, config.fdriveStorageRoot);
      registerDesktopRoutes(groups, {
        activity: personalActivity,
        changes: createDesktopChanges({
          journal: createChangeJournal(db),
          rootIds: () => indexQueries.rootIdsByName(),
          scopes: scopeResolver.verifiedIndexScopes,
          journaledRoots: new Set(journaled === null ? [] : [journaled]),
          trashPathForStorage: (storage) => {
            const settings = trashSettingsForStorage(storage);
            return settings?.enabled === true ? settings.path : null;
          },
        }),
        writes: createDesktopWrites({
          repo: desktopRepo,
          indexedContent: desktopIndexedContent,
          clock,
          access: desktopAccess,
          metadata: desktopMetadata,
          bus,
          logger,
          storageForIdentity: storageWithoutTrash,
          trashPathForStorage: (storage) => {
            const settings = trashSettingsForStorage(storage);
            return settings?.enabled === true ? settings.path : null;
          },
        }),
        apiTokens: repos.apiTokens,
        logins: repos.logins,
        storage: { id: storageId, name: () => storage.name() },
        principalFor,
        clock,
        indexedContent: desktopIndexedContent,
        clientIp: (c) => extractClientIp(c, config.fdriveTrustedProxyHops),
        trashPathForStorage: (storage) => {
          const settings = trashSettingsForStorage(storage);
          return settings?.enabled === true ? settings.path : null;
        },
      });
      registerSharesRoutes(groups, {
        activity: personalActivity,
        thumbnailsEnabled: () => featureService.enabled("thumbnails"),
        service: createSharesService({
          repos,
          shares: shareRepo,
          storageFor: storageFactory,
          trashPathFor: (identityId) => trashSettings.pathForIdentity(identityId),
          passwords,
          zipLimits: { maxBytes: config.fdriveJobMaxBytes },
          clock,
        }),
        codec: createShareCredentialCodec(master, clock),
        limiter: createShareLimiter(clock),
        config,
        indexQueries,
        resolver: scopeResolver,
        identities: repos.identities,
        thumbsDir: config.fdriveThumbsDir,
      });
      registerSetupRoutes(groups, {
        service: setupService,
        tokenGuard: setupTokenGuard,
        limiter,
        config,
      });
      registerStorageRoutes(groups, { service: storage });
      registerLocalUserRoutes(groups, {
        service: localUsers,
        clientIp: (c) => extractClientIp(c, config.fdriveTrustedProxyHops),
      });
      registerGrantRoutes(groups, { service: localGrants });
      // Built as a local variable (not a fresh object literal at the call
      // site below) so `archivePeekMaxBytes` (not part of `FsRoutesDeps`
      // itself; see `fs/archive-routes.ts`'s `ArchiveRoutesDeps`) reaches
      // `registerArchiveRoutes` without TypeScript's excess-property check
      // rejecting it.
      const fsRoutesDeps = {
        activity: personalActivity,
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
          trashPathForStorage: (storage: StorageProvider) => {
            const settings = trashSettingsForStorage(storage);
            return settings?.enabled === true ? settings.path : null;
          },
        },
      };
      registerFsRoutes(groups, fsRoutesDeps);
      registerTrashRoutes(groups, {
        activity: personalActivity,
        bus,
        clock,
        settingsForStorage: trashSettingsForStorage,
        metadata: fsMetadata,
      });
      registerTrashSettingsRoutes(groups, { service: trashSettings, storageId });
      registerPublicUrlRoutes(groups, { service: publicUrl });
      registerOfficeSettingsRoutes(groups, {
        service: officeSettings,
        workerToken: config.fdriveWorkerToken,
        activeProvider: currentOfficeProvider,
      });
      registerOfficeRoutes(groups, { service: officeService });
      registerMetadataRoutes(groups, {
        metadata: metadataService,
        activity: personalActivity,
        reads: activityReads,
        admitActivity,
      });
      registerActivityExports(groups.authed, {
        repo: activityRepo,
        exports: createActivityExportsRepo(db, clock),
      });
      registerPersonalActivityRoutes(groups, {
        repo: activityRepo,
        reads: activityReads,
        admitActivity,
        cursorSecret: config.fdriveMasterKey,
      });
      registerAiRoutes(groups, {
        settings: aiSettings,
        organize: organizeService,
        chat: chatService,
        modelFor: aiModelFor,
      });
      registerEventRoutes(groups, { bus, clock });
      registerSearchRoutes(groups, {
        features: featureValues,
        searchService,
        imageSearchService,
        resolver: scopeResolver,
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
        thumbsDir: config.fdriveThumbsDir,
        trashPathForStorage: (storage) => {
          const settings = trashSettingsForStorage(storage);
          return settings?.enabled === true ? settings.path : null;
        },
      });
      registerActivityRoutes(groups, {
        indexerUrl: config.fdriveIndexerUrl,
        ocrUrl: config.fdriveOcrUrl,
        fetch: fetchImpl,
        features: () => featureService.status(),
        office: () => officeSettings.status(null),
      });
      registerProcessingFailureRoutes(groups, {
        read: createProcessingFailureReader(db),
        indexerUrl: config.fdriveIndexerUrl,
        fetch: fetchImpl,
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
    toolDeps: mcpToolDeps,
  });

  activityMaintenance.start();
  desktopRetention.start();
  return {
    app,
    close: async () => {
      await changes.flush();
      await backups.close();
      await activityMaintenance.stop();
      await desktopRetention.stop();
      if (indexerListener !== null) {
        await indexerListener.stop();
      }
      await activityPathLocks.close();
      await officeLocks.close();
      await pool.end();
    },
  };
}
