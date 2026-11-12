import type { TrashSettings } from "@fdrive/contracts";
import {
  moveTrashLeafPath,
  type ProviderModule,
  StorageError,
  type StorageProvider,
} from "@fdrive/core";
import type { Identity, Provider } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createMemoryStorage } from "@fdrive/testkit";
import { createFakeWebdavServer, webdavModule } from "@fdrive/webdav";
import { expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.js";
import {
  localModuleFixture,
  seedLocalUsers,
  writeHomeFiles,
} from "../local/test-fixtures/index.ts";
import type { IdentityProvider } from "../providers/service.js";
import { fakeProviderModule } from "../providers/test-fixtures/index.ts";
import {
  createIdentityStorageFactory,
  createPinnedStorageFactory,
  trashSettingsForStorage,
  unavailableStorage,
  withIdempotentMkdir,
  withRecycleFolderTrash,
} from "./storage-factory.ts";
import type { TokenSource } from "./token-source.js";

function notImplemented(): never {
  throw new Error("not implemented in this stub");
}

function makeStubStorage(overrides: Partial<StorageProvider>): StorageProvider {
  return {
    list: notImplemented,
    stat: notImplemented,
    statFile: notImplemented,
    download: notImplemented,
    upload: notImplemented,
    mkdir: notImplemented,
    move: notImplemented,
    copy: notImplemented,
    deleteFile: notImplemented,
    deleteDir: notImplemented,
    setModifiedAt: notImplemented,
    zip: notImplemented,
    ...overrides,
  } as StorageProvider;
}

const IDENTITY: Identity = {
  id: "identity-a",
  accountId: "account-1",
  providerId: "provider-a",
  externalUsername: "alice",
  createdAt: new Date(0),
  lastLoginAt: null,
};

function providerRow(id: string, baseUrl: string): Provider {
  return {
    id,
    type: "webdav",
    baseUrl,
    label: "",
    config: {},
    enabled: true,
    managedByEnv: false,
    createdAt: new Date(0),
  };
}

/**
 * Storage that signs every request with the session's upstream token, the
 * way a token-minting backend does: `list` and `deleteFile` each send one
 * request to the instance's address.
 */
const tokenModule: ProviderModule = fakeProviderModule({
  trash: "move",
  createStorage: (instance, session, ctx) =>
    makeStubStorage({
      async list(path) {
        const token = await session.getToken();
        await ctx.fetch(`${instance.baseUrl}/list?path=${encodeURIComponent(path)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return [];
      },
      async deleteFile(path) {
        const token = await session.getToken();
        await ctx.fetch(`${instance.baseUrl}/files?path=${encodeURIComponent(path)}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
      },
    }),
});

function resolvedFor(provider: Provider, module: ProviderModule = tokenModule): IdentityProvider {
  return {
    identity: { ...IDENTITY, providerId: provider.id },
    provider,
    module,
    instance: { id: provider.id, baseUrl: provider.baseUrl, config: provider.config },
  };
}

function tokenSourceStub(
  token: string | null = "a-token",
): Pick<TokenSource, "sessionFor" | "get" | "credential"> {
  return {
    sessionFor: (_identityId, externalUsername) => ({
      externalUsername,
      getCredential: async () => ({ password: "pw" }),
      getToken: async () => token,
      invalidateToken: async () => {},
    }),
    get: async () => token,
    credential: async () => ({ password: "pw" }),
  };
}

const TRASH_SETTINGS: TrashSettings = {
  providerId: "123e4567-e89b-42d3-a456-426614174000",
  revision: 1,
  enabled: true,
  path: "/.trash",
  retentionHours: null,
  rulesConfirmed: true,
  strategy: "native",
};

it("captures the identity's provider for delayed reads/writes without retargeting", async () => {
  const requests: { host: string; authorization: string | null; method: string }[] = [];
  const fetchImpl: typeof globalThis.fetch = async (url, init) => {
    requests.push({
      host: new URL(String(url)).host,
      authorization: new Headers(init?.headers).get("authorization"),
      method: init?.method ?? "GET",
    });
    return Response.json(init?.method === "DELETE" ? { message: "ok" } : []);
  };
  const forIdentity = vi
    .fn()
    .mockResolvedValue(resolvedFor(providerRow("provider-a", "http://a.test")));
  let token: string | null = "a-token";
  const tokenSource: Pick<TokenSource, "sessionFor" | "get" | "credential"> = {
    sessionFor: (_id, externalUsername) => ({
      externalUsername,
      getCredential: async () => ({}),
      getToken: async () => {
        if (token === null) {
          throw new ApiHttpError("upstream_unavailable", "identity provider unavailable");
        }
        return token;
      },
      invalidateToken: async () => {},
    }),
    get: async () => token,
    credential: async () => ({}),
  };
  const factory = createIdentityStorageFactory({
    providers: { forIdentity },
    tokenSource,
    fetch: fetchImpl,
    clock: () => new Date(0),
  });
  const storage = await factory("identity-a");
  forIdentity.mockResolvedValue(resolvedFor(providerRow("provider-b", "http://b.test")));
  await storage.list("/");
  await storage.deleteFile("/same.txt");
  expect(requests.map((request) => request.host)).toEqual(["a.test", "a.test"]);
  expect(requests.map((request) => request.authorization)).toEqual([
    "Bearer a-token",
    "Bearer a-token",
  ]);
  expect(forIdentity).toHaveBeenCalledOnce();
  token = null;
  await expect(storage.deleteFile("/later.txt")).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  expect(requests).toHaveLength(2);
});

it("awaits binding and refuses an unresolved provider", async () => {
  const factory = createIdentityStorageFactory({
    providers: {
      forIdentity: async () => {
        throw new ApiHttpError("upstream_unavailable", "Unavailable");
      },
    },
    tokenSource: tokenSourceStub(),
    fetch: vi.fn(),
    clock: () => new Date(0),
  });
  await expect(factory("identity-a")).rejects.toMatchObject({ kind: "upstream_unavailable" });
});

it("leaves storage.trash undefined when no trash settings are configured", async () => {
  const factory = createIdentityStorageFactory({
    providers: { forIdentity: async () => resolvedFor(providerRow("provider-a", "http://a.test")) },
    tokenSource: tokenSourceStub(),
    fetch: async () => Response.json([]),
    clock: () => new Date(0),
  });
  const storage = await factory("identity-a");
  expect(storage.trash).toBeUndefined();
  expect(trashSettingsForStorage(storage)).toBeNull();
});

it("extends native-trash storage with a recycle-folder view when trash is enabled", async () => {
  // A backend that recycles deletes itself: no production module does this
  // any more, but the port still allows it.
  const memory = createMemoryStorage({ "/.trash/docs/a.txt/1700000000000000000": "x" });
  const module = fakeProviderModule({ trash: "native", createStorage: () => memory });
  const factory = createIdentityStorageFactory({
    providers: {
      forIdentity: async () => resolvedFor(providerRow("provider-a", "http://a.test"), module),
    },
    tokenSource: tokenSourceStub(),
    fetch: vi.fn(),
    clock: () => new Date(0),
    resolveTrashSettings: async () => TRASH_SETTINGS,
  });
  const storage = await factory("identity-a");
  expect(storage.trash).toBeDefined();
  expect((await storage.trash?.list())?.entries.map((entry) => entry.originalPath)).toEqual([
    "/docs/a.txt",
  ]);
  // Native trash: fdrive never moves files itself, a delete is a delete.
  await storage.deleteFile("/.trash/docs/a.txt/1700000000000000000");
  expect(memory.dump()).toEqual({});
});

it("moves deletes into the recycle folder for a module whose trash strategy is move", async () => {
  const memory = createMemoryStorage({ "/docs/a.txt": "x" });
  const module = fakeProviderModule({ trash: "move", createStorage: () => memory });
  const at = new Date("2026-09-10T12:00:00Z");
  const factory = createIdentityStorageFactory({
    providers: {
      forIdentity: async () => resolvedFor(providerRow("provider-a", "http://a.test"), module),
    },
    tokenSource: tokenSourceStub(),
    fetch: vi.fn(),
    clock: () => at,
    resolveTrashSettings: async () => TRASH_SETTINGS,
  });
  const storage = await factory("identity-a");
  await storage.deleteFile("/docs/a.txt");
  const leaf = (BigInt(at.getTime()) * BigInt(1_000_000)).toString();
  expect(memory.dump()).toEqual({
    [moveTrashLeafPath("/.trash", "/docs/a.txt", "file", leaf)]: "x",
  });
  expect((await storage.trash?.list())?.entries).toMatchObject([{ originalPath: "/docs/a.txt" }]);
});

it("adds no trash for a module without one even when settings enable it", async () => {
  const module = fakeProviderModule({ trash: "none", createStorage: () => createMemoryStorage() });
  const factory = createIdentityStorageFactory({
    providers: {
      forIdentity: async () => resolvedFor(providerRow("provider-a", "http://a.test"), module),
    },
    tokenSource: tokenSourceStub(),
    fetch: vi.fn(),
    clock: () => new Date(0),
    resolveTrashSettings: async () => TRASH_SETTINGS,
  });
  const storage = await factory("identity-a");
  expect(storage.trash).toBeUndefined();
  expect(trashSettingsForStorage(storage)).toMatchObject({ revision: 1 });
});

it("keeps a coherent Trash revision per storage while new requests see updates", async () => {
  let settings = TRASH_SETTINGS;
  const factory = createIdentityStorageFactory({
    providers: { forIdentity: async () => resolvedFor(providerRow("provider-a", "http://a.test")) },
    tokenSource: tokenSourceStub(),
    fetch: async () => Response.json([]),
    clock: () => new Date(0),
    resolveTrashSettings: async () => settings,
  });

  const first = await factory("identity-a");
  settings = { ...settings, revision: 2, path: "/deleted" };
  const second = await factory("identity-a");

  expect(trashSettingsForStorage(first)).toMatchObject({ revision: 1, path: "/.trash" });
  expect(trashSettingsForStorage(second)).toMatchObject({ revision: 2, path: "/deleted" });
  expect(first.trash).toBeDefined();
  expect(second.trash).toBeDefined();
});

it("pins storage to a token fetched once and refuses a foreign provider", async () => {
  const get = vi.fn(async () => "pinned-token");
  const requests: string[] = [];
  const factory = createPinnedStorageFactory({
    providers: { forIdentity: async () => resolvedFor(providerRow("provider-a", "http://a.test")) },
    tokenSource: { ...tokenSourceStub(), get },
    fetch: async (_url, init) => {
      requests.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json([]);
    },
  });
  const storage = await factory("identity-a", "provider-a");
  expect(get).toHaveBeenCalledOnce();
  await storage.list("/");
  await storage.list("/");
  expect(requests).toEqual(["Bearer pinned-token", "Bearer pinned-token"]);
  expect(get).toHaveBeenCalledOnce();
  await expect(factory("identity-a", "provider-b")).rejects.toThrow(/not bound/);
});

it("gives pinned storage the stored credential and a token it never forgets", async () => {
  const credential = vi.fn(async () => ({ username: "alice", password: "pw" }));
  const seen: unknown[] = [];
  const module = fakeProviderModule({
    createStorage: (_instance, session) =>
      makeStubStorage({
        async list() {
          seen.push(await session.getCredential());
          await session.invalidateToken();
          seen.push(await session.getToken());
          return [];
        },
      }),
  });
  const factory = createPinnedStorageFactory({
    providers: {
      forIdentity: async () => resolvedFor(providerRow("provider-a", "http://a.test"), module),
    },
    tokenSource: { ...tokenSourceStub("pinned"), credential },
    fetch: vi.fn(),
  });
  await (await factory("identity-a", "provider-a")).list("/");
  expect(seen).toEqual([{ username: "alice", password: "pw" }, "pinned"]);
  expect(credential).toHaveBeenCalledWith("identity-a");
});

it("withRecycleFolderTrash spreads the original provider and adds trash without mutating it", () => {
  const storage = createMemoryStorage();
  const withTrash = withRecycleFolderTrash(storage, "/.trash");
  expect(withTrash.trash).toBeDefined();
  expect(storage.trash).toBeUndefined();
  expect(withTrash.list).toBe(storage.list);
});

it("withIdempotentMkdir passes a successful mkdir straight through", async () => {
  const mkdir = vi.fn().mockResolvedValue(undefined);
  const storage = makeStubStorage({ mkdir });
  await withIdempotentMkdir(storage).mkdir("/new-dir", { parents: true });
  expect(mkdir).toHaveBeenCalledWith("/new-dir", { parents: true });
});

it("withIdempotentMkdir swallows an already-exists failure when stat reports a directory", async () => {
  const storage = makeStubStorage({
    mkdir: async () => {
      throw new StorageError("internal", "failed to create directory");
    },
    stat: async () => ({ kind: "dir", size: 0, modifiedAt: null, contentType: null }),
  });
  await expect(withIdempotentMkdir(storage).mkdir("/")).resolves.toBeUndefined();
});

it("withIdempotentMkdir rethrows when the path is actually a file, not a directory", async () => {
  const failure = new StorageError("internal", "failed to create directory");
  const storage = makeStubStorage({
    mkdir: async () => {
      throw failure;
    },
    stat: async () => ({ kind: "file", size: 1, modifiedAt: null, contentType: null }),
  });
  await expect(withIdempotentMkdir(storage).mkdir("/a-file")).rejects.toBe(failure);
});

it("withIdempotentMkdir rethrows when the path does not exist at all", async () => {
  const failure = new StorageError("not_found", "parent not found");
  const storage = makeStubStorage({
    mkdir: async () => {
      throw failure;
    },
    stat: async () => {
      throw new StorageError("not_found", "not found");
    },
  });
  await expect(withIdempotentMkdir(storage).mkdir("/missing/child")).rejects.toBe(failure);
});

it("withIdempotentMkdir rethrows a non-StorageError from mkdir unchanged", async () => {
  const failure = new Error("boom");
  const storage = makeStubStorage({
    mkdir: async () => {
      throw failure;
    },
  });
  await expect(withIdempotentMkdir(storage).mkdir("/x")).rejects.toBe(failure);
});

it("unavailableStorage rejects every call with the given error and has no trash", async () => {
  const error = new ApiHttpError("upstream_unavailable", "storage provider unavailable");
  const storage = unavailableStorage(error);
  expect(storage.trash).toBeUndefined();
  expect(storage.zip).toBeUndefined();
  await expect(storage.list("/")).rejects.toBe(error);
  await expect(storage.stat("/a")).rejects.toBe(error);
  await expect(storage.statFile("/a")).rejects.toBe(error);
  await expect(storage.download("/a")).rejects.toBe(error);
  await expect(storage.upload("/a", new Uint8Array())).rejects.toBe(error);
  await expect(storage.mkdir("/a")).rejects.toBe(error);
  await expect(storage.move("/a", "/b")).rejects.toBe(error);
  await expect(storage.copy("/a", "/b")).rejects.toBe(error);
  await expect(storage.deleteFile("/a")).rejects.toBe(error);
  await expect(storage.deleteDir("/a")).rejects.toBe(error);
  expect(trashSettingsForStorage(storage)).toBeNull();
});

it("keeps a WebDAV identity and a local identity on the same path apart", async () => {
  const requests: { host: string; authorization: string | null }[] = [];
  const repos = createMemoryRepos();
  const local = localModuleFixture(repos);
  await seedLocalUsers(repos, [{ username: "alice", password: "pw" }]);
  writeHomeFiles(local.root, "alice", { "/shared/a.txt": "from the local folder" });
  const davUser = { username: "alice", password: "teacup" };
  const dav = createFakeWebdavServer({
    users: [davUser],
    origin: "http://dav.test",
    files: { "/shared/a.txt": "from webdav" },
  });
  const fetchImpl: typeof globalThis.fetch = async (url, init) => {
    const host = new URL(String(url)).host;
    requests.push({ host, authorization: new Headers(init?.headers).get("authorization") });
    return dav.fetch(url, init);
  };
  const localRow: Provider = { ...providerRow("provider-local", "local"), type: "local" };
  const davRow: Provider = providerRow("provider-dav", "http://dav.test");
  const forIdentity = vi.fn(
    async (identityId: string): Promise<IdentityProvider> =>
      identityId === "identity-dav"
        ? {
            ...resolvedFor(davRow, webdavModule),
            identity: { ...IDENTITY, id: "identity-dav", providerId: davRow.id },
          }
        : resolvedFor(localRow, local.module),
  );
  const tokenSource: Pick<TokenSource, "sessionFor" | "get" | "credential"> = {
    sessionFor: (identityId, externalUsername) => ({
      externalUsername,
      getCredential: async () => ({
        username: externalUsername,
        password: identityId === "identity-dav" ? davUser.password : "pw",
      }),
      getToken: async () => null,
      invalidateToken: async () => {},
    }),
    get: async () => null,
    credential: async () => ({ password: "pw" }),
  };
  const factory = createIdentityStorageFactory({
    providers: { forIdentity },
    tokenSource,
    fetch: fetchImpl,
    clock: () => new Date(0),
  });
  const davStorage = await factory("identity-dav");
  const localStorage = await factory("identity-a");
  const text = async (storage: StorageProvider) =>
    new Response((await storage.download("/shared/a.txt")).body).text();

  expect(await text(davStorage)).toBe("from webdav");
  expect(await text(localStorage)).toBe("from the local folder");
  await davStorage.upload("/shared/only-dav.txt", new TextEncoder().encode("x"));
  await expect(localStorage.stat("/shared/only-dav.txt")).rejects.toMatchObject({
    kind: "not_found",
  });

  const basic = `Basic ${Buffer.from(`${davUser.username}:${davUser.password}`).toString("base64")}`;
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((request) => request.host === "dav.test")).toBe(true);
  expect(requests.every((request) => request.authorization === basic)).toBe(true);
});

it("asks the module to admit the login before building any storage", async () => {
  const repos = createMemoryRepos();
  const local = localModuleFixture(repos);
  await seedLocalUsers(repos, [{ username: "alice", password: "pw", disabled: true }]);
  const createStorage = vi.spyOn(local.module, "createStorage");
  const localRow: Provider = { ...providerRow("provider-local", "local"), type: "local" };
  const deps = {
    providers: { forIdentity: async () => resolvedFor(localRow, local.module) },
    tokenSource: tokenSourceStub(null),
    fetch: vi.fn(),
    clock: () => new Date(0),
  };

  // A user an administrator disabled after they signed in stops at once.
  await expect(createIdentityStorageFactory(deps)("identity-a")).rejects.toMatchObject({
    kind: "forbidden",
    message: "this user may not sign in",
  });
  await expect(
    createPinnedStorageFactory(deps)("identity-a", "provider-local"),
  ).rejects.toMatchObject({ kind: "forbidden" });
  // So does one whose user was removed.
  await repos.localUsers.delete("alice");
  await expect(createIdentityStorageFactory(deps)("identity-a")).rejects.toBeInstanceOf(
    ApiHttpError,
  );
  expect(createStorage).not.toHaveBeenCalled();

  await seedLocalUsers(repos, [{ username: "alice", password: "pw" }]);
  expect(await (await createIdentityStorageFactory(deps)("identity-a")).list("/")).toEqual([]);
  expect(createStorage).toHaveBeenCalledOnce();
});

it("passes a failure that is not a storage error out of admission unchanged", async () => {
  const failure = new Error("users table unreachable");
  const module = fakeProviderModule({
    admit: async () => {
      throw failure;
    },
  });
  const factory = createIdentityStorageFactory({
    providers: {
      forIdentity: async () => resolvedFor(providerRow("provider-a", "http://a"), module),
    },
    tokenSource: tokenSourceStub(),
    fetch: vi.fn(),
    clock: () => new Date(0),
  });
  await expect(factory("identity-a")).rejects.toBe(failure);
});
