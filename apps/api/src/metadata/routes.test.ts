import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import {
  createFakeSftpgoServer,
  createSftpgoClient,
  createSftpgoStorageProvider,
  type FakeSeed,
  type WithToken,
} from "@fdrive/sftpgo";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createEventBus } from "../events/bus.js";
import { registerFsRoutes } from "../fs/routes.js";
import { createJobRunner, type JobRunner } from "../jobs/runner.js";
import { registerMetadataRoutes } from "./routes.js";
import type { MetadataService } from "./service.js";
import { createMetadataService } from "./service.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const FULL_PERMS = ["*"];
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const ALICE_IDENTITY_ID = "00000000-0000-4000-8000-0000000000a1";
const CLOCK_ISO = "2024-06-01T00:00:00.000Z";

const SEED: FakeSeed = {
  users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
  files: {
    alice: {
      "/hello.txt": "hello world",
      "/dir/nested.txt": "nested contents",
    },
  },
};

function createTestLogger(): Logger {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return logger as unknown as Logger;
}

function buildJobRunner(): JobRunner {
  return createJobRunner({ clock: () => new Date(CLOCK_ISO), bus: createEventBus() });
}

async function withTokenFor(
  client: ReturnType<typeof createSftpgoClient>,
  username: string,
  password: string,
): Promise<WithToken> {
  const token = await client.login({ username, password });
  return async (fn) => fn(token.accessToken);
}

function requestedWith(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, "x-requested-with": "fdrive" } };
}

async function buildHarness(seed: FakeSeed = SEED) {
  const server = createFakeSftpgoServer(seed);
  const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
  const withToken = await withTokenFor(client, "alice", "secret");
  const storage = createSftpgoStorageProvider({ client, withToken });

  const principal: Principal = {
    accountId: ACCOUNT_ID,
    identityId: ALICE_IDENTITY_ID,
    username: "alice",
    storage,
    isAdmin: false,
  };

  const repos = createMemoryRepos();
  const metadata = createMetadataService(repos);
  const bus = createEventBus();
  const config = loadConfig(REQUIRED_ENV);
  const clock = () => new Date(CLOCK_ISO);

  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(CLOCK_ISO),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) => {
      registerFsRoutes(groups, {
        bus,
        clock,
        jobRunner: buildJobRunner(),
        tmpDir: "/tmp",
        jobMaxBytes: 1_000_000_000,
        metadata,
        folderSize: {
          indexQueries: {
            rootIdsByName: async () => ({}),
            subtreeSize: async () => ({ bytes: 0, files: 0 }),
          },
          resolver: {
            verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
          },
          identities: { get: async () => null },
        },
      });
      registerMetadataRoutes(groups, { metadata });
    },
  });

  return { app, repos, metadata };
}

interface TagJson {
  id: string;
  name: string;
  color: string | null;
}

async function createTag(app: ReturnType<typeof createApp>, name: string): Promise<TagJson> {
  const res = await app.request(
    "/api/v1/tags",
    requestedWith({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as TagJson;
}

describe("GET /fs/list decoration", () => {
  it("decorates entries with empty meta when nothing is tagged or favorited", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { path: string; meta?: unknown }[] };
    const hello = body.entries.find((e) => e.path === "/hello.txt");
    expect(hello?.meta).toEqual({ tagIds: [], favorite: false });
  });

  it("decorates entries with tag ids and favorite status", async () => {
    const { app } = await buildHarness();
    const tag = await createTag(app, "Work");

    const setTagsRes = await app.request(
      "/api/v1/fs/tags",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", tagIds: [tag.id] }),
      }),
    );
    expect(setTagsRes.status).toBe(200);

    const favRes = await app.request(
      "/api/v1/favorites",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt" }),
      }),
    );
    expect(favRes.status).toBe(200);

    const listRes = await app.request("/api/v1/fs/list?path=/");
    const body = (await listRes.json()) as {
      entries: { path: string; meta?: { tagIds: string[]; favorite: boolean } }[];
    };
    const hello = body.entries.find((e) => e.path === "/hello.txt");
    expect(hello?.meta).toEqual({ tagIds: [tag.id], favorite: true });
  });
});

describe("PUT /fs/tags", () => {
  it("rejects tag ids that belong to another account with 400 and leaves the file untagged", async () => {
    const { app, repos } = await buildHarness();
    const tag = await createTag(app, "Work");
    const bob = await repos.accounts.create({ displayName: "Bob" });
    const bobsTag = await repos.tags.create(bob.id, { name: "Private", color: null });

    const res = await app.request(
      "/api/v1/fs/tags",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", tagIds: [tag.id, bobsTag.id] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { kind: "bad_request", details: { tagIds: [bobsTag.id] } },
    });

    const listRes = await app.request("/api/v1/fs/list?path=/");
    const body = (await listRes.json()) as {
      entries: { path: string; meta?: { tagIds: string[] } }[];
    };
    expect(body.entries.find((e) => e.path === "/hello.txt")?.meta?.tagIds).toEqual([]);
  });
});

describe("tag CRUD", () => {
  it("creates, lists, updates, and deletes a tag", async () => {
    const { app } = await buildHarness();

    const tag = await createTag(app, "Work");

    const listRes = await app.request("/api/v1/tags");
    expect(await listRes.json()).toEqual({ tags: [tag] });

    const patchRes = await app.request(
      `/api/v1/tags/${tag.id}`,
      requestedWith({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Job" }),
      }),
    );
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toEqual({ ...tag, name: "Job" });

    const deleteRes = await app.request(
      `/api/v1/tags/${tag.id}`,
      requestedWith({ method: "DELETE" }),
    );
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });

    const afterRes = await app.request("/api/v1/tags");
    expect(await afterRes.json()).toEqual({ tags: [] });
  });

  it("returns 409 on a duplicate tag name", async () => {
    const { app } = await buildHarness();
    await createTag(app, "Work");

    const res = await app.request(
      "/api/v1/tags",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Work" }),
      }),
    );

    expect(res.status).toBe(409);
  });

  it("returns 404 patching a tag that does not exist", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/tags/00000000-0000-0000-0000-000000000000",
      requestedWith({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      }),
    );

    expect(res.status).toBe(404);
  });

  it("lists every path assigned a tag", async () => {
    const { app } = await buildHarness();
    const tag = await createTag(app, "Work");

    await app.request(
      "/api/v1/fs/tags",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", tagIds: [tag.id] }),
      }),
    );

    const res = await app.request(`/api/v1/tags/${tag.id}/files`);
    expect(await res.json()).toEqual({ paths: ["/hello.txt"] });
  });
});

describe("favorites", () => {
  it("adds, lists, and removes a favorite, discovering its kind by stat", async () => {
    const { app } = await buildHarness();

    const addRes = await app.request(
      "/api/v1/favorites",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/dir" }),
      }),
    );
    expect(addRes.status).toBe(200);

    const listRes = await app.request("/api/v1/favorites");
    const body = (await listRes.json()) as { items: { path: string; kind: string }[] };
    expect(body.items).toEqual([{ path: "/dir", kind: "dir", addedAt: expect.any(String) }]);

    const removeRes = await app.request(
      "/api/v1/favorites",
      requestedWith({
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/dir" }),
      }),
    );
    expect(removeRes.status).toBe(200);
    expect(await (await app.request("/api/v1/favorites")).json()).toEqual({ items: [] });
  });
});

describe("recents", () => {
  it("touches and lists a recent path", async () => {
    const { app } = await buildHarness();

    const touchRes = await app.request(
      "/api/v1/recents/touch",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt" }),
      }),
    );
    expect(touchRes.status).toBe(200);

    const listRes = await app.request("/api/v1/recents");
    const body = (await listRes.json()) as { items: { path: string }[] };
    expect(body.items.map((item) => item.path)).toEqual(["/hello.txt"]);
  });
});

describe("folder views", () => {
  it("pins an existing directory, returns it, and removes it idempotently", async () => {
    const { app } = await buildHarness();
    const put = await app.request(
      "/api/v1/folder-views",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/dir/.", mode: "grid" }),
      }),
    );
    expect(put.status).toBe(200);

    const get = await app.request("/api/v1/folder-views?path=/dir");
    expect(await get.json()).toEqual({ view: { path: "/dir", mode: "grid", sort: null } });

    const remove = await app.request(
      "/api/v1/folder-views",
      requestedWith({
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/dir" }),
      }),
    );
    expect(await remove.json()).toEqual({ ok: true });
    expect(await (await app.request("/api/v1/folder-views?path=/dir")).json()).toEqual({
      view: null,
    });
  });

  it("rejects file pins and prunes only a confirmed missing pin", async () => {
    const { app, metadata } = await buildHarness();
    const file = await app.request(
      "/api/v1/folder-views",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", mode: "list" }),
      }),
    );
    expect(file.status).toBe(400);
    const invalidMode = await app.request(
      "/api/v1/folder-views",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/dir", mode: "columns" }),
      }),
    );
    expect(invalidMode.status).toBe(400);

    await metadata.setFolderView(ALICE_IDENTITY_ID, "/gone", "tree");
    expect(await (await app.request("/api/v1/folder-views?path=/gone")).json()).toEqual({
      view: null,
    });
    expect(await metadata.getFolderView(ALICE_IDENTITY_ID, "/gone")).toBeNull();
  });

  it("resets pins across every identity linked to the calling account", async () => {
    const { app, repos, metadata } = await buildHarness();
    const provider = await repos.providers.ensure({ type: "test", baseUrl: "http://test" });
    const first = await repos.identities.create({
      accountId: ACCOUNT_ID,
      providerId: provider.id,
      externalUsername: "alice-linked-1",
    });
    const second = await repos.identities.create({
      accountId: ACCOUNT_ID,
      providerId: provider.id,
      externalUsername: "alice-linked-2",
    });
    await Promise.all([
      metadata.setFolderView(first.id, "/one", "grid"),
      metadata.setFolderView(second.id, "/two", "tree"),
    ]);

    const reset = await app.request(
      "/api/v1/folder-views/all",
      requestedWith({ method: "DELETE" }),
    );
    expect(await reset.json()).toEqual({ ok: true });
    await expect(metadata.getFolderView(first.id, "/one")).resolves.toBeNull();
    await expect(metadata.getFolderView(second.id, "/two")).resolves.toBeNull();
  });
});

describe("tag CRUD: error mapping", () => {
  function fail(name: string): never {
    throw new Error(`unexpected call to ${name} in this test`);
  }

  async function buildHarnessWithStubMetadata(
    metadata: MetadataService,
    storageOverride?: StorageProvider,
  ) {
    const server = createFakeSftpgoServer(SEED);
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const withToken = await withTokenFor(client, "alice", "secret");
    const storage = storageOverride ?? createSftpgoStorageProvider({ client, withToken });
    const principal: Principal = {
      accountId: ACCOUNT_ID,
      identityId: ALICE_IDENTITY_ID,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const config = loadConfig(REQUIRED_ENV);
    const clock = () => new Date(CLOCK_ISO);

    return createApp({
      config,
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(CLOCK_ISO),
      clock,
      principalResolver: async () => principal,
      registerRoutes: (groups) => registerMetadataRoutes(groups, { metadata }),
    });
  }

  it("propagates a non-conflict error from createTag rather than mapping it", async () => {
    const metadata: MetadataService = {
      decorate: async (_id, entries) => [...entries],
      listTags: async () => fail("listTags"),
      createTag: async () => {
        throw new Error("boom");
      },
      updateTag: async () => fail("updateTag"),
      deleteTag: async () => fail("deleteTag"),
      filesForTag: async () => fail("filesForTag"),
      setFileTags: async () => fail("setFileTags"),
      listFavorites: async () => fail("listFavorites"),
      addFavorite: async () => fail("addFavorite"),
      removeFavorite: async () => fail("removeFavorite"),
      getFolderView: async () => fail("getFolderView"),
      setFolderView: async () => fail("setFolderView"),
      removeFolderView: async () => fail("removeFolderView"),
      resetFolderViews: async () => fail("resetFolderViews"),
      listRecents: async () => fail("listRecents"),
      touchRecent: async () => fail("touchRecent"),
      onMoved: async () => fail("onMoved"),
      onDeleted: async () => fail("onDeleted"),
      onTrashed: async () => fail("onTrashed"),
      onCopied: () => undefined,
    };
    const app = await buildHarnessWithStubMetadata(metadata);

    const res = await app.request(
      "/api/v1/tags",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Work" }),
      }),
    );

    expect(res.status).toBe(500);
  });

  it.each([
    ["forbidden", 403],
    ["upstream_unavailable", 502],
  ] as const)("keeps a pin when a %s folder stat cannot be confirmed", async (kind, status) => {
    const repos = createMemoryRepos();
    const metadata = createMetadataService(repos);
    await metadata.setFolderView(ALICE_IDENTITY_ID, "/dir", "grid");
    const storage = {
      stat: async () => {
        throw new StorageError(kind, "unavailable");
      },
    } as unknown as StorageProvider;
    const app = await buildHarnessWithStubMetadata(metadata, storage);

    const response = await app.request("/api/v1/folder-views?path=/dir");
    expect(response.status).toBe(status);
    await expect(metadata.getFolderView(ALICE_IDENTITY_ID, "/dir")).resolves.toMatchObject({
      mode: "grid",
    });
  });
});

describe("move and delete keep metadata in sync", () => {
  it("a file move keeps its tags at the new path", async () => {
    const { app } = await buildHarness();
    const tag = await createTag(app, "Work");
    await app.request(
      "/api/v1/fs/tags",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", tagIds: [tag.id] }),
      }),
    );

    const moveRes = await app.request(
      "/api/v1/fs/move",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/moved.txt" }),
      }),
    );
    expect(moveRes.status).toBe(200);

    const filesRes = await app.request(`/api/v1/tags/${tag.id}/files`);
    expect(await filesRes.json()).toEqual({ paths: ["/moved.txt"] });
  });

  it("renaming a folder rewrites nested tagged paths", async () => {
    const { app } = await buildHarness();
    const tag = await createTag(app, "Work");
    await app.request(
      "/api/v1/fs/tags",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/dir/nested.txt", tagIds: [tag.id] }),
      }),
    );

    const renameRes = await app.request(
      "/api/v1/fs/rename",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/dir", newName: "renamed" }),
      }),
    );
    expect(renameRes.status).toBe(200);

    const filesRes = await app.request(`/api/v1/tags/${tag.id}/files`);
    expect(await filesRes.json()).toEqual({ paths: ["/renamed/nested.txt"] });
  });

  it("deleting a file drops its tags and favorite", async () => {
    const { app } = await buildHarness();
    const tag = await createTag(app, "Work");
    await app.request(
      "/api/v1/fs/tags",
      requestedWith({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", tagIds: [tag.id] }),
      }),
    );
    await app.request(
      "/api/v1/favorites",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt" }),
      }),
    );

    const deleteRes = await app.request(
      "/api/v1/fs/delete",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ path: "/hello.txt", kind: "file" }] }),
      }),
    );
    expect(deleteRes.status).toBe(200);

    expect(await (await app.request(`/api/v1/tags/${tag.id}/files`)).json()).toEqual({
      paths: [],
    });
    expect(await (await app.request("/api/v1/favorites")).json()).toEqual({ items: [] });
  });
});
