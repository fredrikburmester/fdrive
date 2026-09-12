import type { FsEvent } from "@fdrive/contracts";
import { isStorageError, type Scope, type StorageProvider } from "@fdrive/core";
import type { FavoriteRepo, FileTagRepo, Identity, IdentityRepo, IndexQueries } from "@fdrive/db";
import { Client } from "pg";
import { z } from "zod";
import type { MetadataService } from "../metadata/service.js";
import { hasTrackedMetadata } from "../metadata/service.js";
import { createReadAuthorizer, type ReadAuthorizer } from "../scoping/read-authorizer.ts";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import type { ConfiguredMappingsResult } from "../scoping/types.ts";
import type { EventBus } from "./bus.js";

/** The `LISTEN`/`NOTIFY` channel the indexer publishes change events on. */
export const DEFAULT_INDEXER_CHANNEL = "idx_events";

/** How long the identity/scope cache is trusted before it is rebuilt from the database. */
export const DEFAULT_SCOPE_CACHE_TTL_MS = 60_000;

const IndexerEventKind = z.enum(["created", "changed", "deleted", "moved"]);

/**
 * The NOTIFY payload the Python indexer publishes on `idx_events`
 * (`services/indexer/src/fdrive_indexer/events.py`): `root` is the
 * configured root's name, `path`/`target_path` are root-relative without a
 * leading slash.
 */
export const IndexerEventPayload = z.object({
  kind: IndexerEventKind,
  root: z.string(),
  path: z.string(),
  target_path: z.string().nullable(),
  at: z.string(),
});

export type IndexerEventPayload = z.infer<typeof IndexerEventPayload>;

/**
 * The subset of a Postgres `LISTEN` connection the listener needs. Modeled
 * as plain callbacks (rather than exposing `pg.Client`'s `EventEmitter`
 * surface directly) so tests can supply a trivial fake with no real
 * connection.
 */
export interface NotificationClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<unknown>;
  onNotification(listener: (payload: string) => void): void;
  onError(listener: (error: unknown) => void): void;
}

/**
 * The subset of `pg.Client` (an `EventEmitter`) `createPgNotificationClient`
 * needs. Extracted as its own type so tests can supply a plain fake instead
 * of a real socket.
 */
export interface PgClientLike {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  on(event: "notification", listener: (message: { payload?: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

/**
 * Wraps a `pg.Client`-like object as a `NotificationClient`. `makeClient`
 * defaults to a real `pg.Client` and is overridable for tests, since a real
 * `pg.Client`'s `notification`/`error`/`end` events cannot be triggered
 * without a live connection.
 */
export function createPgNotificationClient(
  connectionString: string,
  makeClient: (connectionString: string) => PgClientLike = (cs) =>
    new Client({ connectionString: cs }) as unknown as PgClientLike,
): NotificationClient {
  const client = makeClient(connectionString);
  return {
    connect: async () => {
      await client.connect();
    },
    end: async () => {
      await client.end();
    },
    query: (text: string) => client.query(text),
    onNotification(listener) {
      client.on("notification", (message) => {
        if (message.payload !== undefined) {
          listener(message.payload);
        }
      });
    },
    onError(listener) {
      client.on("error", listener);
      client.on("end", () => listener(new Error("indexer-listener: connection closed")));
    },
  };
}

/** Exponential backoff capped at 30s: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... */
export function defaultReconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export interface IndexerListenerLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface IndexerListenerDeps {
  readonly onStorageEvent?: (event: IndexerEventPayload) => Promise<void>;
  readonly createClient: () => NotificationClient;
  readonly identities: IdentityRepo;
  readonly indexQueries: IndexQueries;
  readonly fileTags: FileTagRepo;
  readonly favorites: FavoriteRepo;
  readonly metadata: MetadataService;
  readonly bus: EventBus;
  /**
   * Resolves an identity's trusted, administrator-controlled scope mapping
   * (`ScopeResolver.configuredMappings`), the same mapping Office and
   * metadata-event routing use. Never `verifiedIndexScopes`: this listener
   * is itself downstream of the indexer, so re-verifying against it would
   * be circular, and event routing must keep working when the indexer's own
   * directory-verification path is degraded.
   */
  readonly configuredMappingsFor: (identity: Identity) => Promise<ConfiguredMappingsResult>;
  /** Builds the identity-bound storage a live-read check runs against. */
  readonly storageForIdentity: (identityId: string) => Promise<StorageProvider>;
  readonly indexRootNames: ReadonlySet<string>;
  readonly clock: () => Date;
  readonly logger: IndexerListenerLogger;
  readonly channel?: string;
  readonly scopeCacheTtlMs?: number;
  readonly reconnectDelayMs?: (attempt: number) => number;
  /** Overrides `setTimeout` for reconnect scheduling; tests inject a synchronous stub. */
  readonly scheduleTimeout?: (fn: () => void, ms: number) => void;
  /** Overridable for tests; defaults to `createReadAuthorizer`. */
  readonly createAuthorizer?: (storage: StorageProvider) => ReadAuthorizer;
}

export interface IndexerListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface IdentityScopeEntry {
  readonly identityId: string;
  readonly scopes: readonly Scope[];
}

interface ScopeCache {
  readonly expiresAt: number;
  readonly entries: readonly IdentityScopeEntry[];
  readonly rootIdByName: ReadonlyMap<string, number>;
}

function publish(
  bus: EventBus,
  identityId: string,
  op: FsEvent["op"],
  paths: string[],
  targetPaths: string[] | undefined,
  at: string,
): void {
  const event: FsEvent = {
    type: "fs",
    op,
    identityId,
    paths,
    at,
    ...(targetPaths !== undefined ? { targetPaths } : {}),
  };
  bus.publish(event);
}

async function buildScopeCache(
  deps: Pick<
    IndexerListenerDeps,
    "identities" | "indexQueries" | "configuredMappingsFor" | "indexRootNames"
  >,
): Promise<{ entries: IdentityScopeEntry[]; rootIdByName: Map<string, number> }> {
  const identities = await deps.identities.listAll();
  const entries: IdentityScopeEntry[] = [];
  for (const identity of identities as Identity[]) {
    const configured = await deps.configuredMappingsFor(identity);
    if (!configured.available) {
      continue;
    }
    const scopes = configured.scopes.filter((scope) => deps.indexRootNames.has(scope.rootName));
    if (scopes.length > 0) {
      entries.push({ identityId: identity.id, scopes });
    }
  }
  const rootIds = await deps.indexQueries.rootIdsByName();
  return { entries, rootIdByName: new Map(Object.entries(rootIds)) };
}

type LiveCheckDeps = Pick<IndexerListenerDeps, "storageForIdentity" | "createAuthorizer">;

/**
 * Determines whether `path` is currently a file or a directory, or `null`
 * when that cannot be told safely (missing, denied, or any other error).
 * Never calls `storage.list` on a path of unknown kind: real SFTPGo drops
 * the connection for `list` against a path that is actually a file, so
 * `statFile` must run first and `bad_request` is the only signal this
 * codebase treats as "it's a directory" (see `auth/storage-factory.ts`'s
 * `isExistingDirectory`). The indexer's `moved` event payload never says
 * whether the move was of a file or a directory, so this is required
 * before the live-read check below can pick the right `ReadAuthorizeTarget`.
 * A successful `statFile` is not itself used as authorization proof; the
 * read authorizer's own `authorize` call is.
 */
async function detectKind(
  storage: Pick<StorageProvider, "statFile">,
  path: string,
): Promise<"file" | "dir" | null> {
  try {
    await storage.statFile(path);
    return "file";
  } catch (error) {
    return isStorageError(error) && error.kind === "bad_request" ? "dir" : null;
  }
}

/**
 * True when `identityId`'s own storage can actually read `virtualPath` right
 * now. Every created/changed/relinked/moved-into-scope destination must
 * pass this before it is published to an SSE client or recorded as a
 * relink target: round-tripping through the identity's mapping proves the
 * mapping covers the path, not that the caller may see its contents.
 */
async function isLiveReadable(
  deps: LiveCheckDeps,
  identityId: string,
  virtualPath: string,
): Promise<boolean> {
  let storage: StorageProvider;
  try {
    storage = await deps.storageForIdentity(identityId);
  } catch {
    return false;
  }
  const kind = await detectKind(storage, virtualPath);
  if (kind === null) {
    return false;
  }
  const authorizer = (deps.createAuthorizer ?? ((s) => createReadAuthorizer({ storage: s })))(
    storage,
  );
  const result = await authorizer.authorize({ path: virtualPath, kind });
  return result.allowed;
}

/**
 * Handles a `created`/`changed` event for one identity: publishes an
 * `FsEvent` when the path round-trips within that identity's scope and a
 * live read check confirms the identity can read it right now, so SSE
 * clients refresh listings for changes made over SFTP or any other client
 * without ever being told about a path a mapping change or permission
 * change has since made unreadable.
 */
async function handleCreatedOrChanged(
  deps: LiveCheckDeps & Pick<IndexerListenerDeps, "bus">,
  scopes: readonly Scope[],
  identityId: string,
  event: IndexerEventPayload,
): Promise<void> {
  const virtualPath = roundTripVirtualPath(scopes, event.root, event.path);
  if (virtualPath === null) {
    return;
  }
  if (!(await isLiveReadable(deps, identityId, virtualPath))) {
    return;
  }
  publish(
    deps.bus,
    identityId,
    event.kind === "created" ? "create" : "update",
    [virtualPath],
    undefined,
    event.at,
  );
}

/**
 * Handles a `deleted` event for one identity. When the deleted path carried
 * tags or a favorite, checks for exactly one live file elsewhere in the same
 * root and scope with the same sha256 (mechanism 4 in the plan) and, if
 * found, relinks the metadata as a move instead of dropping it. Metadata
 * continuity always applies once a unique relink candidate exists; the
 * relink is only ever *announced* to the browser as a move (revealing the
 * new path) once a live read check confirms the identity can read it,
 * degrading to a plain delete otherwise.
 */
async function handleDeleted(
  deps: LiveCheckDeps &
    Pick<IndexerListenerDeps, "bus" | "metadata" | "fileTags" | "favorites" | "indexQueries">,
  scopes: readonly Scope[],
  rootIdByName: ReadonlyMap<string, number>,
  identityId: string,
  event: IndexerEventPayload,
): Promise<void> {
  const virtualPath = roundTripVirtualPath(scopes, event.root, event.path);
  if (virtualPath === null) {
    return;
  }

  const rootId = rootIdByName.get(event.root);
  if (rootId !== undefined) {
    const tracked = await hasTrackedMetadata(deps, identityId, virtualPath);
    if (tracked) {
      const sha256 = await deps.indexQueries.deletedRowSha(rootId, event.path);
      if (sha256 !== null) {
        const liveRows = await deps.indexQueries.liveRowsBySha(rootId, sha256);
        const candidates = liveRows
          .map((row) => roundTripVirtualPath(scopes, event.root, row.path))
          .filter((path): path is string => path !== null);
        if (candidates.length === 1) {
          const newVirtualPath = candidates[0] as string;
          await deps.metadata.onMoved(identityId, virtualPath, newVirtualPath, false);
          if (await isLiveReadable(deps, identityId, newVirtualPath)) {
            publish(deps.bus, identityId, "move", [virtualPath], [newVirtualPath], event.at);
          } else {
            publish(deps.bus, identityId, "delete", [virtualPath], undefined, event.at);
          }
          return;
        }
      }
    }
  }

  await deps.metadata.onDeleted(identityId, virtualPath, true);
  publish(deps.bus, identityId, "delete", [virtualPath], undefined, event.at);
}

/**
 * Handles a `moved` event for one identity. Both endpoints in scope is the
 * common case (a real move or rename): metadata always follows the move,
 * but the browser only ever learns the *new* path once a live read check
 * confirms the identity can read it there, degrading to a delete
 * notification otherwise. When only the source resolves, the path left the
 * identity's scope, so it is treated as a delete; when only the target
 * resolves, a path entered scope from outside it, so it is treated as a
 * create, again gated on the same live read check. `isDir` is always
 * `true` for the both-endpoints case: the indexer's event payload does not
 * say whether a rename was of a file or a directory, and treating every
 * rename as a possible directory is harmless (the prefix-only part of
 * `movePrefix` simply matches nothing extra for a plain file).
 */
async function handleMoved(
  deps: LiveCheckDeps & Pick<IndexerListenerDeps, "bus" | "metadata" | "logger">,
  scopes: readonly Scope[],
  identityId: string,
  event: IndexerEventPayload,
): Promise<void> {
  if (event.target_path === null) {
    deps.logger.warn({ event }, "indexer-listener: moved event missing target_path");
    return;
  }

  const srcVirtualPath = roundTripVirtualPath(scopes, event.root, event.path);
  const targetVirtualPath = roundTripVirtualPath(scopes, event.root, event.target_path);

  if (srcVirtualPath !== null && targetVirtualPath !== null) {
    await deps.metadata.onMoved(identityId, srcVirtualPath, targetVirtualPath, true);
    if (await isLiveReadable(deps, identityId, targetVirtualPath)) {
      publish(deps.bus, identityId, "move", [srcVirtualPath], [targetVirtualPath], event.at);
    } else {
      publish(deps.bus, identityId, "delete", [srcVirtualPath], undefined, event.at);
    }
    return;
  }
  if (srcVirtualPath !== null) {
    await deps.metadata.onDeleted(identityId, srcVirtualPath, true);
    publish(deps.bus, identityId, "delete", [srcVirtualPath], undefined, event.at);
    return;
  }
  if (targetVirtualPath !== null && (await isLiveReadable(deps, identityId, targetVirtualPath))) {
    publish(deps.bus, identityId, "create", [targetVirtualPath], undefined, event.at);
  }
}

/** Dispatches `event` for one identity's scopes to the right handler above. */
export async function handleEventForIdentity(
  deps: LiveCheckDeps &
    Pick<
      IndexerListenerDeps,
      "bus" | "metadata" | "fileTags" | "favorites" | "indexQueries" | "logger"
    >,
  scopes: readonly Scope[],
  rootIdByName: ReadonlyMap<string, number>,
  identityId: string,
  event: IndexerEventPayload,
): Promise<void> {
  if (event.kind === "created" || event.kind === "changed") {
    await handleCreatedOrChanged(deps, scopes, identityId, event);
    return;
  }
  if (event.kind === "deleted") {
    await handleDeleted(deps, scopes, rootIdByName, identityId, event);
    return;
  }
  await handleMoved(deps, scopes, identityId, event);
}

/**
 * Builds the indexer event listener: a `LISTEN idx_events` connection that
 * reconnects with backoff on error, resolves every affected identity per
 * event (caching identities and their configured scopes for
 * `scopeCacheTtlMs`, default 60s), and drives metadata rename tracking plus
 * SSE change events. Gate construction on `FDRIVE_INDEX_ROOTS` being
 * configured; there is nothing to listen for otherwise.
 */
export function createIndexerListener(deps: IndexerListenerDeps): IndexerListener {
  const channel = deps.channel ?? DEFAULT_INDEXER_CHANNEL;
  const scopeCacheTtlMs = deps.scopeCacheTtlMs ?? DEFAULT_SCOPE_CACHE_TTL_MS;
  const reconnectDelayMs = deps.reconnectDelayMs ?? defaultReconnectDelayMs;
  let cancelReconnect: (() => void) | null = null;
  const scheduleTimeout =
    deps.scheduleTimeout ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      cancelReconnect = () => clearTimeout(timer);
    });

  let stopped = true;
  let attempt = 0;
  let client: NotificationClient | null = null;
  let cache: ScopeCache | null = null;
  let generation = 0;
  let reconnectPending = false;
  let connecting: Promise<void> | null = null;
  let payloadQueue = Promise.resolve();

  async function getCache(): Promise<ScopeCache> {
    const now = deps.clock().getTime();
    if (cache !== null && cache.expiresAt > now) {
      return cache;
    }
    const built = await buildScopeCache(deps);
    const fresh: ScopeCache = { expiresAt: now + scopeCacheTtlMs, ...built };
    cache = fresh;
    return fresh;
  }

  async function handlePayload(raw: string): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      deps.logger.warn({ raw }, "indexer-listener: payload is not valid JSON");
      return;
    }
    const result = IndexerEventPayload.safeParse(parsedJson);
    if (!result.success) {
      deps.logger.warn(
        { raw, issues: result.error.issues },
        "indexer-listener: payload failed validation",
      );
      return;
    }
    const event = result.data;
    await deps.onStorageEvent?.(event);
    const { entries, rootIdByName } = await getCache();
    for (const entry of entries) {
      await handleEventForIdentity(deps, entry.scopes, rootIdByName, entry.identityId, event);
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectPending) return;
    reconnectPending = true;
    const scheduledGeneration = generation;
    const delay = reconnectDelayMs(attempt++);
    scheduleTimeout(() => {
      if (stopped || generation !== scheduledGeneration) return;
      cancelReconnect = null;
      void (async () => {
        // A slow connect may outlast the delay; do not consume its only retry.
        await connecting;
        if (stopped || generation !== scheduledGeneration) return;
        reconnectPending = false;
        await connect();
      })();
    }, delay);
  }

  async function establish(): Promise<void> {
    const connectionGeneration = generation;
    const previous = client;
    client = null;
    // Detach before closing: pg emits `end`, which must not schedule another retry.
    if (previous !== null) await previous.end().catch(() => undefined);
    if (stopped || generation !== connectionGeneration) return;
    const nextClient = deps.createClient();
    client = nextClient;
    nextClient.onNotification((payload) => {
      if (stopped || client !== nextClient || generation !== connectionGeneration) return;
      payloadQueue = payloadQueue
        .then(async () => {
          if (!stopped && generation === connectionGeneration) await handlePayload(payload);
        })
        .catch((error) => deps.logger.warn({ error }, "indexer-listener: event processing failed"));
    });
    nextClient.onError((error) => {
      if (stopped || client !== nextClient || generation !== connectionGeneration) return;
      deps.logger.warn({ error }, "indexer-listener: connection error, reconnecting");
      scheduleReconnect();
    });
    try {
      await nextClient.connect();
      if (stopped || generation !== connectionGeneration) {
        await nextClient.end().catch(() => undefined);
        return;
      }
      await nextClient.query(`LISTEN ${channel}`);
      attempt = 0;
    } catch (error) {
      if (client === nextClient) client = null;
      await nextClient.end().catch(() => undefined);
      deps.logger.warn({ error }, "indexer-listener: failed to connect, retrying");
      if (generation === connectionGeneration) scheduleReconnect();
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    if (connecting !== null) return connecting;
    connecting = establish();
    try {
      await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      await connect();
    },
    async stop() {
      stopped = true;
      generation += 1;
      reconnectPending = false;
      cancelReconnect?.();
      cancelReconnect = null;
      const current = client;
      client = null;
      if (current !== null) await current.end().catch(() => undefined);
      await connecting;
      await payloadQueue;
    },
  };
}
