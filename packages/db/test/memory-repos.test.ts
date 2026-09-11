import { describe, expect, it, vi } from "vitest";
import { createMemoryRepos } from "../src/testing/memory-repos.js";
import { defineReposSuite } from "./repos-suite.js";

defineReposSuite("memory", () => createMemoryRepos());

describe("createMemoryRepos ids option", () => {
  it("uses the supplied id generator instead of a random uuid", async () => {
    let counter = 0;
    const repos = createMemoryRepos({ ids: () => `id-${++counter}` });

    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://x" });
    const account = await repos.accounts.create({ displayName: null });

    expect(provider.id).toBe("id-1");
    expect(account.id).toBe("id-2");
  });
});

describe("memory metadata path transaction", () => {
  async function seedMetadata() {
    const repos = createMemoryRepos();
    const account = await repos.accounts.create({ displayName: "metadata" });
    const tag = await repos.tags.create(account.id, { name: "tag", color: null });
    const identityId = "identity";
    const source = "/source";
    await repos.fileTags.setTags(identityId, source, [tag.id]);
    await repos.favorites.add(identityId, source, "file");
    await repos.folderViews.set(identityId, source, "grid", { key: "size", direction: "desc" });
    await repos.recents.touch(identityId, source);
    return { repos, tag, identityId, source };
  }

  function pathsAt(repos: ReturnType<typeof createMemoryRepos>, identityId: string, tagId: string) {
    return Promise.all([
      repos.fileTags.pathsForTag(identityId, tagId),
      repos.favorites.list(identityId).then((rows) => rows.map((row) => row.path)),
      repos.folderViews.get(identityId, "/source").then((row) => (row ? [row.path] : [])),
      repos.folderViews.get(identityId, "/target").then((row) => (row ? [row.path] : [])),
      repos.recents.list(identityId, 10).then((rows) => rows.map((row) => row.path)),
    ]).then(([fileTags, favorites, sourceViews, targetViews, recents]) => ({
      fileTags,
      favorites,
      folderViews: [...sourceViews, ...targetViews],
      recents,
    }));
  }

  it.each(["move", "delete"] as const)(
    "never exposes a partial successful %s to a microtask reader",
    async (kind) => {
      const { repos, tag, identityId, source } = await seedMetadata();
      const operation =
        kind === "move"
          ? repos.metadataPaths.movePrefix(identityId, source, "/target", false)
          : repos.metadataPaths.deletePrefix(identityId, source, false);

      await Promise.resolve();
      const observed = pathsAt(repos, identityId, tag.id);
      await expect(observed).resolves.toEqual(
        kind === "move"
          ? {
              fileTags: ["/target"],
              favorites: ["/target"],
              folderViews: ["/target"],
              recents: ["/target"],
            }
          : { fileTags: [], favorites: [], folderViews: [], recents: [] },
      );
      await operation;
    },
  );

  it.each(["move", "delete"] as const)("rolls back every table when a %s fails", async (kind) => {
    const { repos, tag, identityId, source } = await seedMetadata();

    vi.spyOn(repos.recents, kind === "move" ? "movePrefix" : "deletePrefix").mockRejectedValueOnce(
      new Error("forced metadata failure"),
    );

    const operation =
      kind === "move"
        ? repos.metadataPaths.movePrefix(identityId, source, "/target", false)
        : repos.metadataPaths.deletePrefix(identityId, source, false);
    await expect(operation).rejects.toThrow("forced metadata failure");

    expect(await repos.fileTags.pathsForTag(identityId, tag.id)).toEqual([source]);
    expect(await repos.favorites.list(identityId)).toEqual([
      expect.objectContaining({ path: source }),
    ]);
    await expect(repos.folderViews.get(identityId, source)).resolves.toMatchObject({
      sort: { key: "size", direction: "desc" },
    });
    expect(await repos.recents.list(identityId, 10)).toEqual([
      expect.objectContaining({ path: source }),
    ]);
  });

  it("restores empty stores when an empty-identity operation fails", async () => {
    const repos = createMemoryRepos();
    const identityId = "empty";
    vi.spyOn(repos.recents, "deletePrefix").mockRejectedValueOnce(
      new Error("forced empty failure"),
    );

    await expect(repos.metadataPaths.deletePrefix(identityId, "/missing", true)).rejects.toThrow(
      "forced empty failure",
    );

    await expect(repos.fileTags.tagsForPaths(identityId, ["/missing"])).resolves.toEqual(new Map());
    await expect(repos.favorites.list(identityId)).resolves.toEqual([]);
    await expect(repos.folderViews.get(identityId, "/missing")).resolves.toBeNull();
    await expect(repos.recents.list(identityId, 10)).resolves.toEqual([]);
  });

  it("treats a same-path aggregate move as a no-op", async () => {
    const { repos, tag, identityId, source } = await seedMetadata();
    const individualMoves = [
      vi.spyOn(repos.fileTags, "movePrefix"),
      vi.spyOn(repos.favorites, "movePrefix"),
      vi.spyOn(repos.folderViews, "movePrefix"),
      vi.spyOn(repos.recents, "movePrefix"),
    ];

    await repos.metadataPaths.movePrefix(identityId, source, source, true);

    expect(individualMoves.every((move) => move.mock.calls.length === 0)).toBe(true);
    await expect(pathsAt(repos, identityId, tag.id)).resolves.toEqual({
      fileTags: [source],
      favorites: [source],
      folderViews: [source],
      recents: [source],
    });
  });

  it("queues same-identity changes behind the active operation", async () => {
    const { repos, tag, identityId, source } = await seedMetadata();
    const originalMoveRecent = repos.recents.movePrefix.bind(repos.recents);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(repos.recents, "movePrefix").mockImplementationOnce(async (...args) => {
      await originalMoveRecent(...args);
      await firstGate;
    });

    const first = repos.metadataPaths.movePrefix(identityId, source, "/middle", false);
    await Promise.resolve();
    const second = repos.metadataPaths.movePrefix(identityId, "/middle", "/target", false);

    expect(await repos.fileTags.pathsForTag(identityId, tag.id)).toEqual(["/middle"]);
    expect((await repos.favorites.list(identityId)).map((row) => row.path)).toEqual(["/middle"]);
    await expect(repos.folderViews.get(identityId, "/middle")).resolves.not.toBeNull();
    expect((await repos.recents.list(identityId, 10)).map((row) => row.path)).toEqual(["/middle"]);

    releaseFirst();
    await Promise.all([first, second]);
    await expect(pathsAt(repos, identityId, tag.id)).resolves.toEqual({
      fileTags: ["/target"],
      favorites: ["/target"],
      folderViews: ["/target"],
      recents: ["/target"],
    });
  });
});
