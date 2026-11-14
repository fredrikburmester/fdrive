import type { StorageSession } from "@fdrive/core";
import type { ChangeInput } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createFilesFolderGuard, FILES_FOLDER_REASONS } from "@fdrive/local";
import { describe, expect, it, vi } from "vitest";
import { createChangeQueue } from "./change-queue.js";
import { deploymentModules, journalRoot, LOCAL_INDEX_ROOT, localIndexRoot } from "./modules.js";
import { FAST_PASSWORDS, seedLocalUsers, temporaryStorageRoot } from "./test-fixtures/index.ts";

const root = (name: string, storagePath: string) => ({
  name,
  storagePath,
  indexerPath: `/roots/${name}`,
});

describe("localIndexRoot", () => {
  it("is the root whose storage path is the folder, however the path is spelled", () => {
    const roots = [root("photos", "/media"), root("files", "/data/")];
    expect(localIndexRoot(roots, "/data")).toBe("files");
    expect(localIndexRoot(roots, "/srv/../data")).toBe("files");
  });

  it("falls back to the only root there is", () => {
    expect(localIndexRoot([root("files", "/elsewhere")], "/data")).toBe("files");
  });

  it("is files when nothing is indexed or several roots name other folders", () => {
    // Office keys documents by root, so the folder always has a name.
    expect(LOCAL_INDEX_ROOT).toBe("files");
    expect(localIndexRoot(null, "/data")).toBe(LOCAL_INDEX_ROOT);
    expect(localIndexRoot([root("a", "/a"), root("b", "/b")], "/data")).toBe(LOCAL_INDEX_ROOT);
  });
});

describe("journalRoot", () => {
  it("is only a root that names the folder itself", () => {
    expect(journalRoot([root("photos", "/media"), root("files", "/data/")], "/srv/../data")).toBe(
      "files",
    );
    expect(journalRoot([root("files", "/elsewhere")], "/data")).toBeNull();
    expect(journalRoot(null, "/data")).toBeNull();
  });
});

describe("deploymentModules", () => {
  it("has no storage without a files folder", () => {
    const modules = deploymentModules(
      { fdriveStorageRoot: undefined, fdriveIndexRoots: null },
      createMemoryRepos(),
    );
    expect(modules).toEqual({});
  });

  it("serves the files folder over the configured root and the stored users", async () => {
    const repos = createMemoryRepos();
    await seedLocalUsers(repos, [{ username: "alice", password: "alice-pass" }]);
    const storageRoot = temporaryStorageRoot();
    const modules = deploymentModules(
      { fdriveStorageRoot: storageRoot, fdriveIndexRoots: [root("files", storageRoot)] },
      repos,
      FAST_PASSWORDS,
    );
    expect(Object.keys(modules)).toEqual(["local"]);
    const local = modules.local;
    if (local === undefined) throw new Error("no local module");
    const instance = { id: "row", baseUrl: "local", config: {} };
    expect(local.indexRootName?.(instance)).toBe("files");
    expect(await local.probe(instance, { fetch })).toMatchObject({ ok: true });
    expect(
      await local.authenticate(instance, { username: "alice", password: "alice-pass" }, { fetch }),
    ).toEqual({ externalUsername: "alice" });
  });

  it("refuses a share in a folder the deployment closes to shares", async () => {
    const repos = createMemoryRepos();
    await seedLocalUsers(repos, [
      { username: "alice", password: "alice-pass" },
      { username: "bob", password: "bob-pass" },
    ]);
    for (const path of ["/Bin/old", "/Projects"]) {
      await repos.localGrants.put({
        ownerUsername: "alice",
        path,
        granteeUsername: "bob",
        access: "read",
      });
    }
    const storageRoot = temporaryStorageRoot();
    const closedFolders = vi.fn(async () => ["/Bin"]);
    const local = deploymentModules(
      { fdriveStorageRoot: storageRoot, fdriveIndexRoots: null },
      repos,
      FAST_PASSWORDS,
      undefined,
      undefined,
      closedFolders,
    ).local;
    if (local === undefined) throw new Error("no local module");
    const instance = { id: "row", baseUrl: "local", config: {} };
    const alice = local.createStorage(instance, { externalUsername: "alice" }, { fetch });
    await alice.mkdir("/Bin/old", { parents: true });
    await alice.mkdir("/Projects");
    const bob = local.createStorage(instance, { externalUsername: "bob" }, { fetch });
    expect((await bob.list("/Shared with me")).map((entry) => entry.name)).toEqual(["Projects"]);
    expect(closedFolders).toHaveBeenCalledWith("row");
  });

  it("hashes with scrypt by default", async () => {
    const repos = createMemoryRepos();
    const modules = deploymentModules(
      { fdriveStorageRoot: temporaryStorageRoot(), fdriveIndexRoots: null },
      repos,
    );
    const instance = { id: "row", baseUrl: "local", config: {} };
    await expect(
      modules.local?.authenticate(instance, { username: "nobody", password: "x" }, { fetch }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
    expect(modules.local?.indexRootName?.(instance)).toBe(LOCAL_INDEX_ROOT);
  });

  it("refuses storage in a folder its guard refuses", async () => {
    const storageRoot = temporaryStorageRoot();
    const guard = createFilesFolderGuard({
      root: storageRoot,
      facts: { installationId: async () => "id", holdsFiles: async () => true },
    });
    const modules = deploymentModules(
      { fdriveStorageRoot: storageRoot, fdriveIndexRoots: null },
      createMemoryRepos(),
      FAST_PASSWORDS,
      undefined,
      guard,
    );
    const instance = { id: "row", baseUrl: "local", config: {} };
    await expect(modules.local?.admit?.(instance, "alice")).rejects.toMatchObject({
      kind: "upstream_unavailable",
      message: FILES_FOLDER_REASONS.empty,
    });
    expect(() =>
      modules.local?.createStorage(instance, { externalUsername: "alice" }, { fetch }),
    ).toThrow(FILES_FOLDER_REASONS.empty);
  });

  describe("with a change queue", () => {
    const instance = { id: "row", baseUrl: "local", config: {} };
    const session: StorageSession = {
      externalUsername: "alice",
    };

    function queue() {
      const writes: [string, ChangeInput[]][] = [];
      const changes = createChangeQueue({
        write: async (name, items) => {
          writes.push([name, [...items]]);
        },
        onError: vi.fn(),
      });
      return { writes, changes };
    }

    it("records the changes fdrive makes in an indexed files folder", async () => {
      const storageRoot = temporaryStorageRoot();
      const { writes, changes } = queue();
      const modules = deploymentModules(
        { fdriveStorageRoot: storageRoot, fdriveIndexRoots: [root("files", storageRoot)] },
        createMemoryRepos(),
        FAST_PASSWORDS,
        changes,
      );
      const storage = modules.local?.createStorage(instance, session, { fetch });
      await storage?.upload("/a.txt", new TextEncoder().encode("a"));
      await storage?.move("/a.txt", "/b.txt");
      await vi.waitFor(async () => {
        await changes.flush();
        expect(writes.flatMap(([, items]) => items)).toHaveLength(2);
      });
      expect(new Set(writes.map(([name]) => name))).toEqual(new Set(["files"]));
      expect(writes.flatMap(([, items]) => items)).toEqual([
        { path: "alice/a.txt", content: expect.objectContaining({ size: 1 }) },
        { path: "alice/a.txt", targetPath: "alice/b.txt" },
      ]);
    });

    it("records nothing when no root is the files folder itself", async () => {
      const storageRoot = temporaryStorageRoot();
      const { writes, changes } = queue();
      const modules = deploymentModules(
        { fdriveStorageRoot: storageRoot, fdriveIndexRoots: [root("files", "/elsewhere")] },
        createMemoryRepos(),
        FAST_PASSWORDS,
        changes,
      );
      expect(modules.local?.indexRootName?.(instance)).toBe("files");
      const storage = modules.local?.createStorage(instance, session, { fetch });
      await storage?.upload("/a.txt", new TextEncoder().encode("a"));
      await new Promise((resolve) => setImmediate(resolve));
      await changes.flush();
      expect(writes).toEqual([]);
    });
  });
});
