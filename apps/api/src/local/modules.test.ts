import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { deploymentModules, LOCAL_INDEX_ROOT, localIndexRoot } from "./modules.js";
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

describe("deploymentModules", () => {
  it("has WebDAV and S3 only without a local folder", () => {
    const modules = deploymentModules(
      { fdriveStorageRoot: undefined, fdriveIndexRoots: null },
      createMemoryRepos(),
    );
    expect(Object.keys(modules).sort()).toEqual(["s3", "webdav"]);
  });

  it("adds the local folder over the configured root and the stored users", async () => {
    const repos = createMemoryRepos();
    await seedLocalUsers(repos, [{ username: "alice", password: "alice-pass" }]);
    const storageRoot = temporaryStorageRoot();
    const modules = deploymentModules(
      { fdriveStorageRoot: storageRoot, fdriveIndexRoots: [root("files", storageRoot)] },
      repos,
      FAST_PASSWORDS,
    );
    expect(Object.keys(modules).sort()).toEqual(["local", "s3", "webdav"]);
    const local = modules.local;
    if (local === undefined) throw new Error("no local module");
    const instance = { id: "row", baseUrl: "local", config: {} };
    expect(local.indexRootName?.(instance)).toBe("files");
    expect(await local.probe(instance, { fetch })).toMatchObject({ ok: true });
    expect(
      await local.authenticate(instance, { username: "alice", password: "alice-pass" }, { fetch }),
    ).toEqual({ externalUsername: "alice" });
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
});
