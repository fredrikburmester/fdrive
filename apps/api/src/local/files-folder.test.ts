import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeInput } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createFilesFolderGuard, FILES_FOLDER_REASONS, FILES_MARKER } from "@fdrive/local";
import { describe, expect, it, vi } from "vitest";
import { createChangeQueue } from "./change-queue.js";
import {
  createDeploymentFilesFolderGuard,
  deploymentFilesFolder,
  filesFolderHealth,
  journalRoot,
  LOCAL_INDEX_ROOT,
  localIndexRoot,
} from "./files-folder.js";
import { seedLocalUsers, temporaryStorageRoot } from "./test-fixtures/index.ts";

const ID = "3e5d2b8a-7c41-4f0e-a9d6-1b2c3d4e5f60";

function facts(holds: boolean) {
  return { installationId: async () => ID, holdsFiles: async () => holds };
}

function log() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("createDeploymentFilesFolderGuard", () => {
  it("logs an adoption once, then a verified folder, and reports it healthy", async () => {
    const root = temporaryStorageRoot();
    mkdirSync(join(root, "alice"));
    const lines = log();
    await createDeploymentFilesFolderGuard(root, facts(true), lines).verify();
    expect(readFileSync(join(root, FILES_MARKER), "utf8")).toBe(`${ID}\n`);
    expect(lines.info).toHaveBeenCalledExactlyOnceWith(
      `files folder ${root} adopted: wrote ${FILES_MARKER} with this installation's id`,
    );

    // The next start finds its own marker.
    const restarted = createDeploymentFilesFolderGuard(root, facts(true), lines);
    await expect(filesFolderHealth(restarted)).resolves.toBe(true);
    expect(lines.info).toHaveBeenLastCalledWith(`files folder ${root} verified`);
    expect(lines.error).not.toHaveBeenCalled();
  });

  it("logs a refusal loudly and fails health with the reason", async () => {
    const root = temporaryStorageRoot();
    const lines = log();
    const guard = createDeploymentFilesFolderGuard(root, facts(true), lines);
    await expect(filesFolderHealth(guard)).resolves.toEqual({
      failed: FILES_FOLDER_REASONS.empty,
    });
    expect(lines.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`files folder ${root} refused: ${FILES_FOLDER_REASONS.empty}`),
    );
    expect(guard.refusal()).toBe(FILES_FOLDER_REASONS.empty);
    expect(lines.info).not.toHaveBeenCalled();
  });
});

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

describe("deploymentFilesFolder", () => {
  it("serves the files folder over the stored users", async () => {
    const repos = createMemoryRepos();
    await seedLocalUsers(repos, [{ username: "alice", password: "alice-pass" }]);
    const storageRoot = temporaryStorageRoot();
    const folder = deploymentFilesFolder(
      { fdriveStorageRoot: storageRoot, fdriveIndexRoots: [root("files", storageRoot)] },
      repos,
    );
    expect(await folder.health()).toMatchObject({ ok: true });
    await expect(folder.admit("alice")).resolves.toBeUndefined();
    await expect(folder.admit("nobody")).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("refuses a share in the owner's Trash", async () => {
    const repos = createMemoryRepos();
    await seedLocalUsers(repos, [
      { username: "alice", password: "alice-pass" },
      { username: "bob", password: "bob-pass" },
    ]);
    for (const path of ["/.trash/old", "/Projects"]) {
      await repos.localGrants.put({
        ownerUsername: "alice",
        path,
        granteeUsername: "bob",
        access: "read",
      });
    }
    const folder = deploymentFilesFolder(
      { fdriveStorageRoot: temporaryStorageRoot(), fdriveIndexRoots: null },
      repos,
    );
    const alice = folder.storage("alice");
    await alice.mkdir("/.trash/old", { parents: true });
    await alice.mkdir("/Projects");
    const bob = folder.storage("bob");
    expect((await bob.list("/Shared with me")).map((entry) => entry.name)).toEqual(["Projects"]);
  });

  it("refuses storage in a folder its guard refuses", async () => {
    const storageRoot = temporaryStorageRoot();
    const guard = createFilesFolderGuard({
      root: storageRoot,
      facts: { installationId: async () => "id", holdsFiles: async () => true },
    });
    const folder = deploymentFilesFolder(
      { fdriveStorageRoot: storageRoot, fdriveIndexRoots: null },
      createMemoryRepos(),
      { guard },
    );
    await expect(folder.storage("alice").list("/")).rejects.toMatchObject({
      kind: "upstream_unavailable",
      message: FILES_FOLDER_REASONS.empty,
    });
    expect(await folder.health()).toEqual({ ok: false, detail: FILES_FOLDER_REASONS.empty });
  });

  describe("with a change queue", () => {
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
      const storage = deploymentFilesFolder(
        { fdriveStorageRoot: storageRoot, fdriveIndexRoots: [root("files", storageRoot)] },
        createMemoryRepos(),
        { changes },
      ).storage("alice");
      await storage.upload("/a.txt", new TextEncoder().encode("a"));
      await storage.move("/a.txt", "/b.txt");
      await vi.waitFor(async () => {
        await changes.flush();
        expect(writes.flatMap(([, items]) => items)).toHaveLength(2);
      });
      expect(new Set(writes.map(([name]) => name))).toEqual(new Set(["files"]));
      expect(writes.flatMap(([, items]) => items)).toEqual([
        { path: "alice/a.txt", content: expect.objectContaining({ size: 1 }) },
        {
          path: "alice/a.txt",
          targetPath: "alice/b.txt",
          stamp: expect.objectContaining({ size: 1 }),
        },
      ]);
    });

    it("records nothing when no root is the files folder itself", async () => {
      const storageRoot = temporaryStorageRoot();
      const { writes, changes } = queue();
      const storage = deploymentFilesFolder(
        { fdriveStorageRoot: storageRoot, fdriveIndexRoots: [root("files", "/elsewhere")] },
        createMemoryRepos(),
        { changes },
      ).storage("alice");
      await storage.upload("/a.txt", new TextEncoder().encode("a"));
      await new Promise((resolve) => setImmediate(resolve));
      await changes.flush();
      expect(writes).toEqual([]);
    });
  });
});
