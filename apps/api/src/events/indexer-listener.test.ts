import {
  type HomeTemplate,
  parseHomeTemplate,
  type Scope,
  StorageError,
  scopesFor,
} from "@fdrive/core";
import type { FavoriteRepo, FileTagRepo, Identity, IndexedFile, IndexQueries } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import type {
  MetadataFavoriteItem,
  MetadataRecentItem,
  MetadataService,
  MetadataTag,
} from "../metadata/service.js";
import type { ReadAuthorizeReason, ReadAuthorizer } from "../scoping/read-authorizer.ts";
import { fakeStorageProvider } from "../scoping/test-fixtures/index.ts";
import type { ConfiguredMappingsResult } from "../scoping/types.ts";
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

/** Resolves every identity's configured mapping from `homeTemplate` and its own username, matching `ScopeResolver.configuredMappings` without overrides. */
function configuredMappingsFor(
  homeTemplate: HomeTemplate,
): (identity: Identity) => Promise<ConfiguredMappingsResult> {
  return async (identity) => {
    try {
      const scopes = scopesFor({ template: homeTemplate, username: identity.externalUsername });
      return {
        available: true,
        providerId: identity.providerId,
        homeTemplateRaw: "sftpgo:/{username}",
        scopes,
      };
    } catch {
      return { available: false, reason: "invalid_configuration" };
    }
  };
}

/** An authorizer that allows every target, unless `deniedPaths` says otherwise. */
function fakeAuthorizer(deniedPaths: ReadonlySet<string> = new Set()): ReadAuthorizer {
  return {
    async authorize(target) {
      if (deniedPaths.has(target.path)) {
        return { allowed: false, reason: "denied" satisfies ReadAuthorizeReason };
      }
      return { allowed: true };
    },
  };
}

/** Live-check deps that allow every path by default; `statFile` always resolves so kind detection succeeds. */
function allowAllLiveCheck(deniedPaths?: ReadonlySet<string>) {
  return {
    storageForIdentity: async () =>
      fakeStorageProvider({
        statFile: async () => ({ size: 0, modifiedAt: null, contentType: null }),
      }),
    createAuthorizer: () => fakeAuthorizer(deniedPaths),
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
    getFolderView: async () => fail("getFolderView"),
    setFolderView: async () => fail("setFolderView"),
    removeFolderView: async () => fail("removeFolderView"),
    resetFolderViews: async () => fail("resetFolderViews"),
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
    directoriesWithFiles: overrides.directoriesWithFiles ?? (async () => []),
    stats: overrides.stats ?? (async () => fail("stats")),
    statsForFileIds: overrides.statsForFileIds ?? (async () => fail("statsForFileIds")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    recordMove: overrides.recordMove ?? (async () => fail("recordMove")),
    recentMoves: overrides.recentMoves ?? (async () => fail("recentMoves")),
    deletedRowSha: overrides.deletedRowSha ?? (async () => fail("deletedRowSha")),
    liveRowsBySha: overrides.liveRowsBySha ?? (async () => fail("liveRowsBySha")),
    searchImages: overrides.searchImages ?? (async () => fail("searchImages")),
    imageEmbeddingStats: overrides.imageEmbeddingStats ?? (async () => fail("imageEmbeddingStats")),
    subtreeSize: overrides.subtreeSize ?? (async () => fail("subtreeSize")),
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
  it("publishes create for a path in scope and live-readable", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();
    const { logger } = makeLogger();

    await handleEventForIdentity(
      {
        ...allowAllLiveCheck(),
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
        ...allowAllLiveCheck(),
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
        ...allowAllLiveCheck(),
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

  it("does not publish when the live read check denies the path", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();
    const { logger } = makeLogger();

    await handleEventForIdentity(
      {
        ...allowAllLiveCheck(new Set(["/a.txt"])),
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
      makeEvent({ kind: "created" }),
    );

    expect(received).toEqual([]);
  });

  it("does not publish when the destination is shadowed by a more specific override", async () => {
    // "/shared" shadows "alice"'s physical "/alice/shared" subtree; an event
    // reporting a change under that physical path must never surface via the
    // home scope once the more specific override exists.
    const scopes: readonly Scope[] = [
      { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
      { rootName: "sftpgo", fsPrefix: "/team", virtualPrefix: "/shared" },
    ];
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();

    await handleEventForIdentity(
      {
        ...allowAllLiveCheck(),
        bus,
        metadata,
        fileTags: {} as FileTagRepo,
        favorites: {} as FavoriteRepo,
        indexQueries: fakeIndexQueries(),
        logger: makeLogger().logger,
      },
      scopes,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "created", path: "alice/shared/x.txt" }),
    );

    expect(received).toEqual([]);
  });
});

describe("handleEventForIdentity: live-read kind detection", () => {
  it("live-checks a moved directory destination with list, not download", async () => {
    // The indexer's `moved` payload never says whether the move was of a
    // file or a directory; `statFile` reporting `bad_request` is the only
    // safe signal that a path is a directory (never call `list` on a path
    // of unknown kind against real SFTPGo).
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();
    const listCalls: string[] = [];
    const storage = fakeStorageProvider({
      statFile: async () => {
        throw new StorageError("bad_request", "is a directory");
      },
      list: async (path) => {
        listCalls.push(path);
        return [];
      },
    });

    await handleEventForIdentity(
      {
        storageForIdentity: async () => storage,
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
      makeEvent({ kind: "moved", path: "alice/docs", target_path: "alice/renamed" }),
    );

    expect(listCalls).toEqual(["/renamed"]);
    expect(received[0]).toMatchObject({ op: "move", paths: ["/docs"], targetPaths: ["/renamed"] });
  });

  it("does not publish when the destination's kind cannot be determined safely", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();
    const storage = fakeStorageProvider({
      statFile: async () => {
        throw new StorageError("forbidden", "no access");
      },
    });

    await handleEventForIdentity(
      {
        storageForIdentity: async () => storage,
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
      makeEvent({ kind: "created" }),
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
        ...allowAllLiveCheck(),
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
      {
        ...allowAllLiveCheck(),
        bus,
        metadata,
        fileTags,
        favorites,
        indexQueries,
        logger: makeLogger().logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "deleted" }),
    );

    expect(calls.onDeleted).toEqual([]);
    expect(calls.onMoved).toEqual([[IDENTITY_ID, "/a.txt", "/b.txt", false]]);
    expect(received[0]).toMatchObject({ op: "move", paths: ["/a.txt"], targetPaths: ["/b.txt"] });
  });

  it("still relinks metadata but only announces a delete when the relink target is not live-readable", async () => {
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
      {
        ...allowAllLiveCheck(new Set(["/b.txt"])),
        bus,
        metadata,
        fileTags,
        favorites,
        indexQueries,
        logger: makeLogger().logger,
      },
      SCOPES,
      ROOT_ID_BY_NAME,
      IDENTITY_ID,
      makeEvent({ kind: "deleted" }),
    );

    expect(calls.onMoved).toEqual([[IDENTITY_ID, "/a.txt", "/b.txt", false]]);
    expect(received[0]).toMatchObject({ op: "delete", paths: ["/a.txt"] });
    expect(received[0]).not.toHaveProperty("targetPaths");
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
      {
        ...allowAllLiveCheck(),
        bus,
        metadata,
        fileTags,
        favorites,
        indexQueries,
        logger: makeLogger().logger,
      },
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
      {
        ...allowAllLiveCheck(),
        bus,
        metadata,
        fileTags,
        favorites,
        indexQueries,
        logger: makeLogger().logger,
      },
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
      {
        ...allowAllLiveCheck(),
        bus,
        metadata,
        fileTags,
        favorites,
        indexQueries,
        logger: makeLogger().logger,
      },
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
        ...allowAllLiveCheck(),
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
        ...allowAllLiveCheck(),
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
  it("relinks metadata and publishes move when both endpoints are in scope and live-readable", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();

    await handleEventForIdentity(
      {
        ...allowAllLiveCheck(),
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

  it("still relinks metadata but announces only a delete when the target is not live-readable", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();

    await handleEventForIdentity(
      {
        ...allowAllLiveCheck(new Set(["/b.txt"])),
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
    expect(received[0]).toMatchObject({ op: "delete", paths: ["/a.txt"] });
    expect(received[0]).not.toHaveProperty("targetPaths");
  });

  it("treats a move out of scope as a delete", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();

    await handleEventForIdentity(
      {
        ...allowAllLiveCheck(),
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
        ...allowAllLiveCheck(),
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

  it("does not publish a move-into-scope create when the target is not live-readable", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata } = fakeMetadataService();

    await handleEventForIdentity(
      {
        ...allowAllLiveCheck(new Set(["/a.txt"])),
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

    expect(received).toEqual([]);
  });

  it("does nothing for a move entirely outside scope", async () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: IDENTITY_ID }, (e) => received.push(e));
    const { metadata, calls } = fakeMetadataService();

    await handleEventForIdentity(
      {
        ...allowAllLiveCheck(),
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
        ...allowAllLiveCheck(),
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

async function seedIdentity(repos: ReturnType<typeof createMemoryRepos>) {
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://x" });
  const account = await repos.accounts.create({ displayName: "Alice" });
  return repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
}

describe("createIndexerListener", () => {
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger: makeLogger().logger,
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger: makeLogger().logger,
      ...allowAllLiveCheck(),
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

  it("never dispatches to an identity whose configured provider no longer matches", async () => {
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
      // A root named "sftpgo" exists in the event, but this identity's
      // provider mapping never resolves: the same root name on a
      // different provider must never be treated as this identity's data.
      configuredMappingsFor: async () => ({ available: false, reason: "provider_mismatch" }),
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger: makeLogger().logger,
      ...allowAllLiveCheck(),
    });
    await listener.start();

    const identities = await repos.identities.listAll();
    const identityId = identities[0]?.id;
    if (identityId === undefined) {
      throw new Error("expected a seeded identity");
    }
    bus.subscribe({ identityId }, (e) => received.push(e));

    fake.notify(JSON.stringify(makeEvent()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([]);

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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger,
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger,
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger: makeLogger().logger,
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
      scheduleTimeout: (fn, ms) => scheduled.push([fn, ms]),
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
      scheduleTimeout: (fn, ms) => scheduled.push([fn, ms]),
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
      scheduleTimeout: (fn, ms) => scheduled.push([fn, ms]),
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger: makeLogger().logger,
      ...allowAllLiveCheck(),
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: () => new Date(AT),
      logger,
      onStorageEvent: async () => {
        order.push("registry");
        if (shouldFail) throw new Error("registry failed");
      },
      ...allowAllLiveCheck(),
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

describe("createIndexerListener: storageForIdentity failure", () => {
  it("treats a storage resolution failure as denied, never publishing", async () => {
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
      configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
      indexRootNames: ROOT_NAMES,
      clock: clock.now,
      logger: makeLogger().logger,
      storageForIdentity: async () => {
        throw new Error("token unavailable");
      },
    });
    await listener.start();

    const identities = await repos.identities.listAll();
    const identityId = identities[0]?.id;
    if (identityId === undefined) throw new Error("expected a seeded identity");
    bus.subscribe({ identityId }, (e) => received.push(e));

    fake.notify(JSON.stringify(makeEvent()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([]);
    await listener.stop();
  });
});

it("processes notifications in order and continues after a failed payload", async () => {
  const repos = createMemoryRepos();
  const fake = createFakeNotificationClient();
  const { metadata } = fakeMetadataService();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: string[] = [];
  const listener = createIndexerListener({
    createClient: () => fake.client,
    identities: repos.identities,
    indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({ sftpgo: 1 }) }),
    fileTags: repos.fileTags,
    favorites: repos.favorites,
    metadata,
    bus: createEventBus(),
    configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
    indexRootNames: ROOT_NAMES,
    clock: () => new Date(AT),
    logger: makeLogger().logger,
    ...allowAllLiveCheck(),
    onStorageEvent: async (event) => {
      received.push(event.path);
      if (event.path === "first") {
        await blocked;
        throw new Error("first failed");
      }
    },
  });
  await listener.start();
  fake.notify(JSON.stringify({ ...makeEvent(), path: "first" }));
  fake.notify(JSON.stringify({ ...makeEvent(), path: "second" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toEqual(["first"]);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toEqual(["first", "second"]);
  await listener.stop();
});

it("coalesces repeated errors, closes the old client and ignores stale callbacks after restart", async () => {
  const repos = createMemoryRepos();
  const first = createFakeNotificationClient();
  const second = createFakeNotificationClient();
  const { metadata } = fakeMetadataService();
  const scheduled: (() => void)[] = [];
  let creations = 0;
  const listener = createIndexerListener({
    createClient: () => (++creations === 1 ? first.client : second.client),
    identities: repos.identities,
    indexQueries: fakeIndexQueries(),
    fileTags: repos.fileTags,
    favorites: repos.favorites,
    metadata,
    bus: createEventBus(),
    configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
    indexRootNames: ROOT_NAMES,
    clock: () => new Date(AT),
    logger: makeLogger().logger,
    ...allowAllLiveCheck(),
    scheduleTimeout: (fn) => scheduled.push(fn),
  });
  await listener.start();
  await listener.start();
  expect(creations).toBe(1);
  first.fail(new Error("error"));
  first.fail(new Error("end"));
  expect(scheduled).toHaveLength(1);
  scheduled[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(first.state.ended).toBe(true);
  expect(creations).toBe(2);
  first.fail(new Error("stale"));
  expect(scheduled).toHaveLength(1);
  second.fail(new Error("retry"));
  await listener.stop();
  await listener.start();
  scheduled[1]?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(creations).toBe(3);
  await listener.stop();
});

it("cancels real reconnect timers and recovers when closing the old client fails", async () => {
  vi.useFakeTimers();
  const repos = createMemoryRepos();
  const first = createFakeNotificationClient();
  const second = createFakeNotificationClient();
  const { metadata } = fakeMetadataService();
  let creations = 0;
  const listener = createIndexerListener({
    createClient: () => (++creations === 1 ? first.client : second.client),
    identities: repos.identities,
    indexQueries: fakeIndexQueries(),
    fileTags: repos.fileTags,
    favorites: repos.favorites,
    metadata,
    bus: createEventBus(),
    configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
    indexRootNames: ROOT_NAMES,
    clock: () => new Date(AT),
    logger: makeLogger().logger,
    ...allowAllLiveCheck(),
  });
  try {
    await listener.start();
    vi.spyOn(first.client, "end").mockRejectedValue(new Error("already disconnected"));
    first.fail(new Error("connection reset"));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(creations).toBe(2);
    second.fail(new Error("retry"));
    expect(vi.getTimerCount()).toBe(1);
    await listener.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(creations).toBe(2);
  } finally {
    await listener.stop();
    vi.useRealTimers();
  }
});

it("stops a slow connection without LISTEN even if closing it fails", async () => {
  const repos = createMemoryRepos();
  const fake = createFakeNotificationClient();
  let finishConnect!: () => void;
  const connected = new Promise<void>((resolve) => {
    finishConnect = resolve;
  });
  fake.state.connectImpl = () => connected;
  vi.spyOn(fake.client, "end").mockRejectedValue(new Error("disconnected"));
  const { metadata } = fakeMetadataService();
  const listener = createIndexerListener({
    createClient: () => fake.client,
    identities: repos.identities,
    indexQueries: fakeIndexQueries(),
    fileTags: repos.fileTags,
    favorites: repos.favorites,
    metadata,
    bus: createEventBus(),
    configuredMappingsFor: configuredMappingsFor(HOME_TEMPLATE),
    indexRootNames: ROOT_NAMES,
    clock: () => new Date(AT),
    logger: makeLogger().logger,
    ...allowAllLiveCheck(),
  });
  const starting = listener.start();
  const stopping = listener.stop();
  finishConnect();
  await Promise.all([starting, stopping]);
  expect(fake.state.queries).toEqual([]);
});
