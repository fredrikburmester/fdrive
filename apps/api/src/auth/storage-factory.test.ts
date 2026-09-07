import { StorageError, type StorageProvider } from "@fdrive/core";
import { createSftpgoClient } from "@fdrive/sftpgo";
import { expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../test/fixtures/memory-storage.ts";
import { ApiHttpError } from "../errors.js";
import {
  createIdentityStorageFactory,
  withIdempotentMkdir,
  withRecycleFolderTrash,
} from "./storage-factory.ts";

function notImplemented(): never {
  throw new Error("not implemented in this stub");
}

function makeStubStorage(overrides: Partial<StorageProvider>): StorageProvider {
  return {
    list: notImplemented,
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
  };
}

it("captures client and identity for delayed reads/writes without retargeting", async () => {
  const requests: { host: string; authorization: string | null; method: string }[] = [];
  const fixed = (baseUrl: string) =>
    createSftpgoClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({
          host: new URL(String(url)).host,
          authorization: new Headers(init?.headers).get("authorization"),
          method: init?.method ?? "GET",
        });
        return Response.json(init?.method === "DELETE" ? { message: "ok" } : []);
      },
    });
  const clientForIdentity = vi.fn().mockResolvedValue(fixed("http://a.test"));
  const tokenCalls: string[] = [];
  let tokenFailure: Error | null = null;
  const withToken = async <T>(
    identityId: string,
    fn: (token: string) => Promise<T>,
  ): Promise<T> => {
    tokenCalls.push(identityId);
    if (tokenFailure) throw tokenFailure;
    return fn("a-token");
  };
  const factory = createIdentityStorageFactory({ clientForIdentity, tokenSource: { withToken } });
  const storage = await factory("identity-a");
  clientForIdentity.mockResolvedValue(fixed("http://b.test"));
  await storage.list("/");
  await storage.deleteFile("/same.txt");
  expect(requests.map((request) => request.host)).toEqual(["a.test", "a.test"]);
  expect(requests.map((request) => request.authorization)).toEqual([
    "Bearer a-token",
    "Bearer a-token",
  ]);
  expect(tokenCalls).toEqual(["identity-a", "identity-a"]);
  expect(clientForIdentity).toHaveBeenCalledOnce();
  tokenFailure = new ApiHttpError("upstream_unavailable", "identity provider unavailable");
  await expect(storage.deleteFile("/later.txt")).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  expect(requests).toHaveLength(2);
});
it("awaits binding and refuses an unresolved provider", async () => {
  const factory = createIdentityStorageFactory({
    clientForIdentity: async () => {
      throw new ApiHttpError("upstream_unavailable", "Unavailable");
    },
    tokenSource: { withToken: vi.fn() },
  });
  await expect(factory("identity-a")).rejects.toMatchObject({ kind: "upstream_unavailable" });
});

it("leaves storage.trash undefined when no trashPath is configured", async () => {
  const fixed = createSftpgoClient({
    baseUrl: "http://a.test",
    fetch: async () => Response.json([]),
  });
  const factory = createIdentityStorageFactory({
    clientForIdentity: async () => fixed,
    tokenSource: { withToken: async (_id, fn) => fn("a-token") },
  });
  const storage = await factory("identity-a");
  expect(storage.trash).toBeUndefined();
});

it("extends storage with a recycle-folder trash when trashPath is configured", async () => {
  const fixed = createSftpgoClient({
    baseUrl: "http://a.test",
    fetch: async () => Response.json([]),
  });
  const factory = createIdentityStorageFactory({
    clientForIdentity: async () => fixed,
    tokenSource: { withToken: async (_id, fn) => fn("a-token") },
    trashPath: "/.trash",
  });
  const storage = await factory("identity-a");
  expect(storage.trash).toBeDefined();
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

it("withIdempotentMkdir swallows an already-exists failure (statFile reports bad_request, this codebase's directory convention)", async () => {
  const storage = makeStubStorage({
    mkdir: async () => {
      throw new StorageError("internal", "failed to create directory");
    },
    statFile: async () => {
      throw new StorageError("bad_request", "is a directory");
    },
  });
  await expect(withIdempotentMkdir(storage).mkdir("/")).resolves.toBeUndefined();
});

it("withIdempotentMkdir rethrows when the path is actually a file, not a directory", async () => {
  const failure = new StorageError("internal", "failed to create directory");
  const storage = makeStubStorage({
    mkdir: async () => {
      throw failure;
    },
    statFile: async () => ({ size: 1, modifiedAt: null, contentType: null }),
  });
  await expect(withIdempotentMkdir(storage).mkdir("/a-file")).rejects.toBe(failure);
});

it("withIdempotentMkdir rethrows when the path does not exist at all", async () => {
  const failure = new StorageError("not_found", "parent not found");
  const storage = makeStubStorage({
    mkdir: async () => {
      throw failure;
    },
    statFile: async () => {
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
