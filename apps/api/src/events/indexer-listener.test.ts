import { parseHomeTemplate } from "@fdrive/core";
import type { FavoriteRepo, FileTagRepo, IndexedFile, IndexQueries } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import type {
  MetadataFavoriteItem,
  MetadataRecentItem,
  MetadataService,
  MetadataTag,
} from "../metadata/service.js";
import { type BusEvent, createEventBus } from "./bus.js";
import {
  createIndexerListener,
  createPgNotificationClient,
  DEFAULT_INDEXER_CHANNEL,
  defaultReconnectDelayMs,
  handleEventForIdentity,
  type IndexerEventPayload,
  type IndexerListenerLogger,
  type NotificationClient,
  type PgClientLike,
} from "./indexer-listener.js";

const HOME_TEMPLATE = parseHomeTemplate("sftpgo:/{username}");
const ROOT_NAMES = new Set(["sftpgo"]);
const SCOPES = [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }];
const AT = "2026-01-01T00:00:00.000Z";

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function makeLogger(): { logger: IndexerListenerLogger; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  return {
    logger: { warn: (obj, msg) => warnings.push([obj, msg]) },
    warnings,
  };
}

interface MetadataCalls {
  onMoved: [string, string, string, boolean][];
  onDeleted: [string, string, boolean][];
}

function fakeMetadataService(): { metadata: MetadataService; calls: MetadataCalls } {
  const calls: MetadataCalls = { onMoved: [], onDeleted: [] };
  const metadata: MetadataService = {
    decorate: async (_id, entries) => [...entries],
    listTags: async (): Promise<MetadataTag[]> => fail("listTags"),
    createTag: async () => fail("createTag"),
    updateTag: async () => fail("updateTag"),
    deleteTag: async () => fail("deleteTag"),
    filesForTag: async () => fail("filesForTag"),
    setFileTags: async () => fail("setFileTags"),
    listFavorites: async (): Promise<MetadataFavoriteItem[]> => fail("listFavorites"),
    addFavorite: async () => fail("addFavorite"),
    removeFavorite: async () => fail("removeFavorite"),
    listRecents: async (): Promise<MetadataRecentItem[]> => fail("listRecents"),
    touchRecent: async () => fail("touchRecent"),
    async onMoved(identityId, oldPath, newPath, isDir) {
      calls.onMoved.push([identityId, oldPath, newPath, isDir]);
    },
    async onDeleted(identityId, path, isDir) {
      calls.onDeleted.push([identityId, path, isDir]);
    },
    onTrashed: async () => fail("onTrashed"),
    onCopied: () => undefined,
  };
  return { metadata, calls };
}

function fakeIndexQueries(overrides: Partial<IndexQueries> = {}): IndexQueries {
  return {
    semantic: overrides.semantic ?? (async () => fail("semantic")),
    fulltext: overrides.fulltext ?? (async () => fail("fulltext")),
    filename: overrides.filename ?? (async () => fail("filename")),
    filesByIds: overrides.filesByIds ?? (async () => fail("filesByIds")),
    fileByPath: overrides.fileByPath ?? (async () => fail("fileByPath")),
    listFiles: overrides.listFiles ?? (async () => fail("listFiles")),
    filesBySha256: overrides.filesBySha256 ?? (async () => fail("filesBySha256")),
    rootIdsByName: overrides.rootIdsByName ?? (async () => ({ sftpgo: 1 })),
    stats: overrides.stats ?? (async () => fail("stats")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    recordMove: overrides.recordMove ?? (async () => fail("recordMove")),
    recentMoves: overrides.recentMoves ?? (async () => fail("recentMoves")),
    deletedRowSha: overrides.deletedRowSha ?? (async () => fail("deletedRowSha")),
    liveRowsBySha: overrides.liveRowsBySha ?? (async () => fail("liveRowsBySha")),
  };
}

function fileAt(path: string): IndexedFile {
  return {
    id: 1,
    rootId: 1,
    path,
    name: path.split("/").at(-1) ?? path,
    ext: "",
    size: 10,
    mtimeNs: 1n,
    sha256: "abc",
    mime: null,
    textStatus: "none",
    textChars: 0,
    error: null,
    indexedAt: null,
    deletedAt: null,
  };
}

function makeEvent(overrides: Partial<IndexerEventPayload> = {}): IndexerEventPayload {
  return {
    kind: "created",
    root: "sftpgo",
    path: "alice/a.txt",
    target_path: null,
    at: AT,
    ...overrides,
  };
}

const IDENTITY_ID = "identity-1";
const ROOT_ID_BY_NAME = new Map([["sftpgo", 1]]);

describe("handleEventForIdentity: created/changed", () => {
  it("publishes create for a path in scope", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();
    const { logger } = makeLogger();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: { tagsForPaths: async () => new Map() } as unknown as FileTagRepo,
        favorites: { has: async () => new Set() } as unknown as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "created" }),
    );

    expect(received).toEqual([
      { type: "fs", op: "create", identityId: IDENTITY_ID, paths: ["/a.txt"], at: AT },
    ]);
  });

  it("publishes update for a changed path", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();
    const { logger } = makeLogger();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "changed" }),
    );

    expect(received[0]).toMatchObject({ op: "update" });
  });

  it("does nothing for a path outside the identity's scope", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();
    const { logger } = makeLogger();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "created", path: "bob/a.txt" }),
    );

    expect(received).toEqual([]);
  });
});

describe("handleEventForIdentity: deleted", () => {
  it("drops metadata and publishes delete when the path has no tracked metadata", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();
    const fileTags = { tagsForPaths: async () => new Map() } as unknown as FileTagRepo;
    const favorites = { has: async () => new Set() } as unknown as FavoriteRepo;

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags,
        favorites,
        indexQueries: fakeIndexQueries(),
        logger: makeLogger().logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "deleted" }),
    );

    expect(calls.onDeleted).toEqual([[IDENTITY_ID, "/a.txt", true]]);
    expect(received).toEqual([
      { type: "fs", op: "delete", identityId: IDENTITY_ID, paths: ["/a.txt"], at: AT },
    ]);
  });

  it("relinks as a move when exactly one live row shares the deleted row's sha256", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();
    const fileTags = {
      tagsForPaths: async () => new Map([["/a.txt", ["tag-1"]]]),
    } as unknown as FileTagRepo;
    const favorites = { has: async () => new Set() } as unknown as FavoriteRepo;
    const indexQueries = fakeIndexQueries({
      deletedRowSha: async () => "sha-1",
      liveRowsBySha: async () => [fileAt("alice/b.txt")],
    });

    await handleEventForIdentity(
      { bus, metadata, fileTags, favorites, indexQueries, logger: makeLogger().logger },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "deleted" }),
    );

    expect(calls.onDeleted).toEqual([]);
    expect(calls.onMoved).toEqual([[IDENTITY_ID, "/a.txt", "/b.txt", false]]);
    expect(received[0]).toMatchObject({ op: "move", paths: ["/a.txt"], targetPaths: ["/b.txt"] });
  });

  it("falls back to a plain delete when more than one live row shares the sha256", async () => {
    const { metadata, calls } = fakeMetadataService();
    const bus = createEventBus();
    const fileTags = {
      tagsForPaths: async () => new Map([["/a.txt", ["tag-1"]]]),
    } as unknown as FileTagRepo;
    const favorites = { has: async () => new Set() } as unknown as FavoriteRepo;
    const indexQueries = fakeIndexQueries({
      deletedRowSha: async () => "sha-1",
      liveRowsBySha: async () => [fileAt("alice/b.txt"), fileAt("alice/c.txt")],
    });

    await handleEventForIdentity(
      { bus, metadata, fileTags, favorites, indexQueries, logger: makeLogger().logger },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "deleted" }),
    );

    expect(calls.onDeleted).toEqual([[IDENTITY_ID, "/a.txt", true]]);
    expect(calls.onMoved).toEqual([]);
  });

  it("falls back to a plain delete when no live row shares the sha256", async () => {
    const { metadata, calls } = fakeMetadataService();
    const bus = createEventBus();
    const fileTags = {
      tagsForPaths: async () => new Map([["/a.txt", ["tag-1"]]]),
    } as unknown as FileTagRepo;
    const favorites = { has: async () => new Set() } as unknown as FavoriteRepo;
    const indexQueries = fakeIndexQueries({
      deletedRowSha: async () => "sha-1",
      liveRowsBySha: async () => [],
    });

    await handleEventForIdentity(
      { bus, metadata, fileTags, favorites, indexQueries, logger: makeLogger().logger },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "deleted" }),
    );

    expect(calls.onDeleted).toEqual([[IDENTITY_ID, "/a.txt", true]]);
  });

  it("skips the sha lookup when the deleted row itself has no sha256", async () => {
    const { metadata, calls } = fakeMetadataService();
    const bus = createEventBus();
    const fileTags = {
      tagsForPaths: async () => new Map([["/a.txt", ["tag-1"]]]),
    } as unknown as FileTagRepo;
    const favorites = { has: async () => new Set() } as unknown as FavoriteRepo;
    const indexQueries = fakeIndexQueries({ deletedRowSha: async () => null });

    await handleEventForIdentity(
      { bus, metadata, fileTags, favorites, indexQueries, logger: makeLogger().logger },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "deleted" }),
    );

    expect(calls.onDeleted).toEqual([[IDENTITY_ID, "/a.txt", true]]);
  });

  it("skips the sha lookup entirely when the root is not known to the index", async () => {
    const { metadata, calls } = fakeMetadataService();
    const bus = createEventBus();
    const fileTags = { tagsForPaths: async () => fail("tagsForPaths") } as unknown as FileTagRepo;
    const favorites = { has: async () => fail("has") } as unknown as FavoriteRepo;

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags,
        favorites,
        indexQueries: fakeIndexQueries(),
        logger: makeLogger().logger,
      },
      SCOPES,
      new Map(),
      IDENTITY_ID,
      makeEvent({ kind: "deleted" }),
    );

    expect(calls.onDeleted).toEqual([[IDENTITY_ID, "/a.txt", true]]);
  });

  it("does nothing for a deleted path outside the identity's scope", async () => {
    const { metadata, calls } = fakeMetadataService();
    const bus = createEventBus();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger: makeLogger().logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "deleted", path: "bob/a.txt" }),
    );

    expect(calls.onDeleted).toEqual([]);
  });
});

describe("handleEventForIdentity: moved", () => {
  it("relinks metadata and publishes move when both endpoints are in scope", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger: makeLogger().logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "moved", path: "alice/a.txt", target_path: "alice/b.txt" }),
    );

    expect(calls.onMoved).toEqual([[IDENTITY_ID, "/a.txt", "/b.txt", true]]);
    expect(received[0]).toMatchObject({ op: "move", paths: ["/a.txt"], targetPaths: ["/b.txt"] });
  });

  it("treats a move out of scope as a delete", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger: makeLogger().logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "moved", path: "alice/a.txt", target_path: "bob/a.txt" }),
    );

    expect(calls.onDeleted).toEqual([[IDENTITY_ID, "/a.txt", true]]);
    expect(received[0]).toMatchObject({ op: "delete", paths: ["/a.txt"] });
  });

  it("treats a move into scope as a create", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger: makeLogger().logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "moved", path: "bob/a.txt", target_path: "alice/a.txt" }),
    );

    expect(calls.onMoved).toEqual([]);
    expect(calls.onDeleted).toEqual([]);
    expect(received[0]).toMatchObject({ op: "create", paths: ["/a.txt"] });
  });

  it("does nothing for a move entirely outside scope", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger: makeLogger().logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "moved", path: "bob/a.txt", target_path: "bob/b.txt" }),
    );

    expect(calls).toEqual({ onMoved: [], onDeleted: [] });
    expect(received).toEqual([]);
  });

  it("logs a warning and does nothing when target_path is missing", async () => {
    const bus = createEventBus();
    const { metadata, calls } = fakeMetadataService();
    const { logger, warnings } = makeLogger();

    await handleEventForIdentity(
      {
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "moved", target_path: null }),
    );

    expect(calls).toEqual({ onMoved: [], onDeleted: [] });
    expect(warnings).toHaveLength(1);
  });
});

function createFakeNotificationClient() {
  let notificationListener: ((payload: string) => void) | null = null;
  let errorListener: ((error: unknown) => void) | null = null;
  const state = {
    connectCalls: 0,
    queries: [] as string[],
    ended: false,
    connectImpl: async (): Promise<void> => undefined,
  };

  const client: NotificationClient = {
    async connect() {
      state.connectCalls += 1;
      await state.connectImpl();
    },
    async end() {
      state.ended = true;
    },
    async query(text) {
      state.queries.push(text);
    },
    onNotification(listener) {
      notificationListener = listener;
    },
    onError(listener) {
      errorListener = listener;
    },
  };

  return {
    client,
    state,
    notify: (payload: string) => notificationListener?.(payload),
    fail: (error: unknown) => errorListener?.(error),
  };
}

function fakeClock(startIso: string) {
  let now = new Date(startIso).getTime();
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createIndexerListener", () => {
  async function seedIdentity(repos: ReturnType<typeof createMemoryRepos>) {
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://x" });
    const account = await repos.accounts.create({ displayName: "Alice" });
    return repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
  }

  it("connects and issues LISTEN on start", async () => {
    const repos = createMemoryRepos();
    const identity = await seedIdentity(repos);
    const fake = createFakeNotificationClient();
    const bus = createEventBus();
    const { metadata } = fakeMetadataService();
    const clock = fakeClock(AT);

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: repos.identities,
      indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({ sftpgo: 1 }) }),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus,
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger: makeLogger().logger,
    });

    await listener.start();

    expect(fake.state.connectCalls).toBe(1);
    expect(fake.state.queries).toEqual([`LISTEN ${DEFAULT_INDEXER_CHANNEL}`]);
    expect(identity.externalUsername).toBe("alice");

    await listener.stop();
    expect(fake.state.ended).toBe(true);
  });

  it("dispatches a valid notification to every identity in scope", async () => {
    const repos = createMemoryRepos();
    await seedIdentity(repos);
    const fake = createFakeNotificationClient();
    const bus = createEventBus();
    const received: BusEvent[] = [];
    const { metadata } = fakeMetadataService();
    const clock = fakeClock(AT);

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: repos.identities,
      indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({ sftpgo: 1 }) }),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus,
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger: makeLogger().logger,
    });
    await listener.start();

    // Subscribe after start (the identity id is only known once seeded); use
    // a wildcard-like check by subscribing per known identity below instead.
    const identities = await repos.identities.listAll();
    const identityId = identities[0]?.id;
    if (identityId === undefined) {
      throw new Error("expected a seeded identity");
    }
    bus.subscribe({ identityId }, (e) => received.push(e));

    fake.notify(
      JSON.stringify({
        kind: "created",
        root: "sftpgo",
        path: "alice/a.txt",
        target_path: null,
        at: AT,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([{ type: "fs", op: "create", identityId, paths: ["/a.txt"], at: AT }]);

    await listener.stop();
  });

  it("logs a warning and does not throw on invalid JSON", async () => {
    const repos = createMemoryRepos();
    await seedIdentity(repos);
    const fake = createFakeNotificationClient();
    const { metadata } = fakeMetadataService();
    const { logger, warnings } = makeLogger();
    const clock = fakeClock(AT);

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: repos.identities,
      indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({ sftpgo: 1 }) }),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus: createEventBus(),
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger,
    });
    await listener.start();

    fake.notify("not-json");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnings.length).toBeGreaterThan(0);
    await listener.stop();
  });

  it("logs a warning and does not throw when the payload fails schema validation", async () => {
    const repos = createMemoryRepos();
    await seedIdentity(repos);
    const fake = createFakeNotificationClient();
    const { metadata } = fakeMetadataService();
    const { logger, warnings } = makeLogger();
    const clock = fakeClock(AT);

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: repos.identities,
      indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({ sftpgo: 1 }) }),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus: createEventBus(),
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger,
    });
    await listener.start();

    fake.notify(JSON.stringify({ kind: "not-a-kind" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnings.length).toBeGreaterThan(0);
    await listener.stop();
  });

  it("caches identities and scopes across events within the TTL", async () => {
    const repos = createMemoryRepos();
    await seedIdentity(repos);
    const fake = createFakeNotificationClient();
    const { metadata } = fakeMetadataService();
    const clock = fakeClock(AT);

    let listAllCalls = 0;
    const countingIdentities: typeof repos.identities = {
      ...repos.identities,
      listAll: async () => {
        listAllCalls += 1;
        return repos.identities.listAll();
      },
    };

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: countingIdentities,
      indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({ sftpgo: 1 }) }),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus: createEventBus(),
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger: makeLogger().logger,
    });
    await listener.start();

    const payload = JSON.stringify({
      kind: "created",
      root: "sftpgo",
      path: "alice/a.txt",
      target_path: null,
      at: AT,
    });
    fake.notify(payload);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.notify(payload);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listAllCalls).toBe(1);

    clock.advance(61_000);
    fake.notify(payload);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listAllCalls).toBe(2);

    await listener.stop();
  });

  it("reconnects with backoff after a connection error", async () => {
    const repos = createMemoryRepos();
    const fake = createFakeNotificationClient();
    const { metadata } = fakeMetadataService();
    const scheduled: [() => void, number][] = [];

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: repos.identities,
      indexQueries: fakeIndexQueries(),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus: createEventBus(),
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
      scheduleTimeout: (fn, ms) => scheduled.push([fn, ms]),
    });
    await listener.start();

    fake.fail(new Error("connection reset"));

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.[1]).toBe(defaultReconnectDelayMs(0));

    // Running the scheduled reconnect creates a new client and reconnects.
    const before = fake.state.connectCalls;
    scheduled[0]?.[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.state.connectCalls).toBe(before + 1);

    await listener.stop();
  });

  it("retries with backoff when the initial connect rejects", async () => {
    const repos = createMemoryRepos();
    const fake = createFakeNotificationClient();
    fake.state.connectImpl = async () => {
      throw new Error("refused");
    };
    const { metadata } = fakeMetadataService();
    const scheduled: [() => void, number][] = [];

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: repos.identities,
      indexQueries: fakeIndexQueries(),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus: createEventBus(),
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
      scheduleTimeout: (fn, ms) => scheduled.push([fn, ms]),
    });

    await listener.start();

    expect(scheduled).toHaveLength(1);
  });

  it("stop() before any reconnect fires prevents a scheduled reconnect from running", async () => {
    const repos = createMemoryRepos();
    const fake = createFakeNotificationClient();
    const { metadata } = fakeMetadataService();
    const scheduled: [() => void, number][] = [];

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: repos.identities,
      indexQueries: fakeIndexQueries(),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus: createEventBus(),
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
      scheduleTimeout: (fn, ms) => scheduled.push([fn, ms]),
    });
    await listener.start();
    fake.fail(new Error("boom"));
    expect(scheduled).toHaveLength(1);

    await listener.stop();
    const before = fake.state.connectCalls;
    scheduled[0]?.[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.state.connectCalls).toBe(before);
  });
});

describe("createIndexerListener: stop()", () => {
  it("swallows an error from the client's end()", async () => {
    const repos = createMemoryRepos();
    const fake = createFakeNotificationClient();
    fake.client.end = async () => {
      throw new Error("already closed");
    };
    const { metadata } = fakeMetadataService();

    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities: repos.identities,
      indexQueries: fakeIndexQueries(),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus: createEventBus(),
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
    });
    await listener.start();

    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it("is a no-op when called before start()", async () => {
    const repos = createMemoryRepos();
    const { metadata } = fakeMetadataService();

    const listener = createIndexerListener({
      createClient: () => fail("createClient"),
      identities: repos.identities,
      indexQueries: fakeIndexQueries(),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus: createEventBus(),
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
    });

    await expect(listener.stop()).resolves.toBeUndefined();
  });
});

describe("defaultReconnectDelayMs", () => {
  it("doubles from 1s up to a 30s cap", () => {
    expect(defaultReconnectDelayMs(0)).toBe(1000);
    expect(defaultReconnectDelayMs(1)).toBe(2000);
    expect(defaultReconnectDelayMs(2)).toBe(4000);
    expect(defaultReconnectDelayMs(10)).toBe(30_000);
  });
});

describe("createPgNotificationClient", () => {
  it("builds a real pg.Client-backed client without connecting", () => {
    const client = createPgNotificationClient("postgres://localhost/fdrive");
    expect(client).toBeDefined();
    expect(typeof client.connect).toBe("function");
    expect(typeof client.end).toBe("function");
    expect(typeof client.query).toBe("function");
    expect(typeof client.onNotification).toBe("function");
    expect(typeof client.onError).toBe("function");
  });

  function fakePgClientLike(): {
    pgClient: PgClientLike;
    emitNotification: (payload?: string) => void;
    emitError: (error: Error) => void;
    emitEnd: () => void;
    queries: string[];
  } {
    const listeners: {
      notification: ((message: { payload?: string }) => void)[];
      error: ((error: Error) => void)[];
      end: (() => void)[];
    } = { notification: [], error: [], end: [] };
    const queries: string[] = [];

    const pgClient: PgClientLike = {
      connect: async () => undefined,
      end: async () => undefined,
      query: async (text) => {
        queries.push(text);
      },
      on: ((event: "notification" | "error" | "end", listener: unknown) => {
        if (event === "notification") {
          listeners.notification.push(listener as (message: { payload?: string }) => void);
        } else if (event === "error") {
          listeners.error.push(listener as (error: Error) => void);
        } else {
          listeners.end.push(listener as () => void);
        }
        return pgClient;
      }) as PgClientLike["on"],
    };

    return {
      pgClient,
      emitNotification: (payload) => {
        for (const listener of listeners.notification) {
          listener(payload !== undefined ? { payload } : {});
        }
      },
      emitError: (error) => {
        for (const listener of listeners.error) {
          listener(error);
        }
      },
      emitEnd: () => {
        for (const listener of listeners.end) {
          listener();
        }
      },
      queries,
    };
  }

  it("forwards notifications with a payload to the listener", () => {
    const fake = fakePgClientLike();
    const client = createPgNotificationClient("postgres://x", () => fake.pgClient);
    const received: string[] = [];
    client.onNotification((payload) => received.push(payload));

    fake.emitNotification("hello");
    fake.emitNotification(undefined);

    expect(received).toEqual(["hello"]);
  });

  it("forwards connection errors and treats end as an error", () => {
    const fake = fakePgClientLike();
    const client = createPgNotificationClient("postgres://x", () => fake.pgClient);
    const received: unknown[] = [];
    client.onError((error) => received.push(error));

    fake.emitError(new Error("boom"));
    fake.emitEnd();

    expect(received).toHaveLength(2);
    expect(received[0]).toBeInstanceOf(Error);
    expect(received[1]).toBeInstanceOf(Error);
  });

  it("connect, query, and end delegate to the underlying client", async () => {
    const fake = fakePgClientLike();
    const client = createPgNotificationClient("postgres://x", () => fake.pgClient);

    await client.connect();
    await client.query(`LISTEN ${DEFAULT_INDEXER_CHANNEL}`);
    await client.end();

    expect(fake.queries).toEqual([`LISTEN ${DEFAULT_INDEXER_CHANNEL}`]);
  });
});

describe("global storage registry hook", () => {
  it("awaits the hook once before identity fanout and catches failure", async () => {
    const repos = createMemoryRepos();
    const fake = createFakeNotificationClient();
    const bus = createEventBus();
    const { metadata } = fakeMetadataService();
    const { logger, warnings } = makeLogger();
    const order: string[] = [];
    const identities = {
      ...repos.identities,
      listAll: async () => {
        order.push("identities");
        return [];
      },
    };
    let shouldFail = false;
    const listener = createIndexerListener({
      createClient: () => fake.client,
      identities,
      indexQueries: fakeIndexQueries(),
      fileTags: repos.fileTags,
      favorites: repos.favorites,
      metadata,
      bus,
      homeTemplate: HOME_TEMPLATE,
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger,
      onStorageEvent: async () => {
        order.push("registry");
        if (shouldFail) throw new Error("registry failed");
      },
    });
    await listener.start();
    fake.notify(JSON.stringify(makeEvent()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["registry", "identities"]);
    shouldFail = true;
    fake.notify(JSON.stringify(makeEvent()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings.at(-1)?.[1]).toBe("indexer-listener: event processing failed");
    await listener.stop();
  });
});
