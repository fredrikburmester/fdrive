import type { FsEvent } from "@fdrive/contracts";
import type { HomeTemplate, Scope } from "@fdrive/core";
import { toVirtualPath } from "@fdrive/core";
import type { FavoriteRepo, FileTagRepo, Identity, IdentityRepo, IndexQueries } from "@fdrive/db";
import { Client } from "pg";
import { z } from "zod";
import type { MetadataService } from "../metadata/service.js";
import { hasTrackedMetadata } from "../metadata/service.js";
import { usableScopesFor } from "../search/scopes.js";
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
  readonly createClient: () => NotificationClient;
  readonly identities: IdentityRepo;
  readonly indexQueries: IndexQueries;
  readonly fileTags: FileTagRepo;
  readonly favorites: FavoriteRepo;
  readonly metadata: MetadataService;
  readonly bus: EventBus;
  readonly homeTemplate: HomeTemplate;
  readonly indexRootNames: ReadonlySet<string>;
  readonly clock: () => Date;
  readonly logger: IndexerListenerLogger;
  readonly channel?: string;
  readonly scopeCacheTtlMs?: number;
  readonly reconnectDelayMs?: (attempt: number) => number;
  /** Overrides `setTimeout` for reconnect scheduling; tests inject a synchronous stub. */
  readonly scheduleTimeout?: (fn: () => void, ms: number) => void;
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
    "identities" | "indexQueries" | "homeTemplate" | "indexRootNames"
  >,
): Promise<{ entries: IdentityScopeEntry[]; rootIdByName: Map<string, number> }> {
  const identities = await deps.identities.listAll();
  const entries: IdentityScopeEntry[] = [];
  for (const identity of identities as Identity[]) {
    const scopes = usableScopesFor(
      deps.homeTemplate,
      deps.indexRootNames,
      identity.externalUsername,
    );
    if (scopes.length > 0) {
      entries.push({ identityId: identity.id, scopes });
    }
  }
  const rootIds = await deps.indexQueries.rootIdsByName();
  return { entries, rootIdByName: new Map(Object.entries(rootIds)) };
}

/**
 * Handles a `created`/`changed` event for one identity: publishes an
 * `FsEvent` when the path falls in that identity's scope, so SSE clients
 * refresh listings for changes made over SFTP or any other client.
 */
function handleCreatedOrChanged(
  deps: Pick<IndexerListenerDeps, "bus">,
  scopes: readonly Scope[],
  identityId: string,
  event: IndexerEventPayload,
): void {
  const virtualPath = toVirtualPath(scopes, event.root, event.path);
  if (virtualPath === null) {
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
 * found, relinks the metadata as a move instead of dropping it.
 */
async function handleDeleted(
  deps: Pick<IndexerListenerDeps, "bus" | "metadata" | "fileTags" | "favorites" | "indexQueries">,
  scopes: readonly Scope[],
  rootIdByName: ReadonlyMap<string, number>,
  identityId: string,
  event: IndexerEventPayload,
): Promise<void> {
  const virtualPath = toVirtualPath(scopes, event.root, event.path);
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
          .map((row) => toVirtualPath(scopes, event.root, row.path))
          .filter((path): path is string => path !== null);
        if (candidates.length === 1) {
          const newVirtualPath = candidates[0] as string;
          await deps.metadata.onMoved(identityId, virtualPath, newVirtualPath, false);
          publish(deps.bus, identityId, "move", [virtualPath], [newVirtualPath], event.at);
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
 * common case (a real move or rename). When only the source resolves, the
 * path left the identity's scope, so it is treated as a delete; when only
 * the target resolves, a path entered scope from outside it, so it is
 * treated as a create. `isDir` is always `true`: the indexer's event payload
 * does not say whether a rename was of a file or a directory, and treating
 * every rename as a possible directory is harmless (the prefix-only part of
 * `movePrefix` simply matches nothing extra for a plain file).
 */
async function handleMoved(
  deps: Pick<IndexerListenerDeps, "bus" | "metadata" | "logger">,
  scopes: readonly Scope[],
  identityId: string,
  event: IndexerEventPayload,
): Promise<void> {
  if (event.target_path === null) {
    deps.logger.warn({ event }, "indexer-listener: moved event missing target_path");
    return;
  }

  const srcVirtualPath = toVirtualPath(scopes, event.root, event.path);
  const targetVirtualPath = toVirtualPath(scopes, event.root, event.target_path);

  if (srcVirtualPath !== null && targetVirtualPath !== null) {
    await deps.metadata.onMoved(identityId, srcVirtualPath, targetVirtualPath, true);
    publish(deps.bus, identityId, "move", [srcVirtualPath], [targetVirtualPath], event.at);
    return;
  }
  if (srcVirtualPath !== null) {
    await deps.metadata.onDeleted(identityId, srcVirtualPath, true);
    publish(deps.bus, identityId, "delete", [srcVirtualPath], undefined, event.at);
    return;
  }
  if (targetVirtualPath !== null) {
    publish(deps.bus, identityId, "create", [targetVirtualPath], undefined, event.at);
  }
}

/** Dispatches `event` for one identity's scopes to the right handler above. */
export async function handleEventForIdentity(
  deps: Pick<
    IndexerListenerDeps,
    "bus" | "metadata" | "fileTags" | "favorites" | "indexQueries" | "logger"
  >,
  scopes: readonly Scope[],
  rootIdByName: ReadonlyMap<string, number>,
  identityId: string,
  event: IndexerEventPayload,
): Promise<void> {
  if (event.kind === "created" || event.kind === "changed") {
    handleCreatedOrChanged(deps, scopes, identityId, event);
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
 * event (caching identities and their scopes for `scopeCacheTtlMs`, default
 * 60s), and drives metadata rename tracking plus SSE change events. Gate
 * construction on `FDRIVE_INDEX_ROOTS` being configured; there is nothing to
 * listen for otherwise.
 */
export function createIndexerListener(deps: IndexerListenerDeps): IndexerListener {
  const channel = deps.channel ?? DEFAULT_INDEXER_CHANNEL;
  const scopeCacheTtlMs = deps.scopeCacheTtlMs ?? DEFAULT_SCOPE_CACHE_TTL_MS;
  const reconnectDelayMs = deps.reconnectDelayMs ?? defaultReconnectDelayMs;
  const scheduleTimeout = deps.scheduleTimeout ?? ((fn, ms) => void setTimeout(fn, ms));

  let stopped = true;
  let attempt = 0;
  let client: NotificationClient | null = null;
  let cache: ScopeCache | null = null;

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
    const { entries, rootIdByName } = await getCache();
    for (const entry of entries) {
      await handleEventForIdentity(deps, entry.scopes, rootIdByName, entry.identityId, event);
    }
  }

  function scheduleReconnect(): void {
    if (stopped) {
      return;
    }
    const delay = reconnectDelayMs(attempt);
    attempt += 1;
    scheduleTimeout(() => {
      void connect();
    }, delay);
  }

  async function connect(): Promise<void> {
    if (stopped) {
      return;
    }
    const nextClient = deps.createClient();
    client = nextClient;
    nextClient.onNotification((payload) => {
      void handlePayload(payload);
    });
    nextClient.onError((error) => {
      deps.logger.warn({ error }, "indexer-listener: connection error, reconnecting");
      scheduleReconnect();
    });
    try {
      await nextClient.connect();
      await nextClient.query(`LISTEN ${channel}`);
      attempt = 0;
    } catch (error) {
      deps.logger.warn({ error }, "indexer-listener: failed to connect, retrying");
      scheduleReconnect();
    }
  }

  return {
    async start() {
      stopped = false;
      await connect();
    },
    async stop() {
      stopped = true;
      const current = client;
      client = null;
      if (current !== null) {
        await current.end().catch(() => undefined);
      }
    },
  };
}
