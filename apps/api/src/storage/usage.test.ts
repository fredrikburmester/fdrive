import { describe, expect, it, vi } from "vitest";
import { createHomeUsage } from "./usage.js";

const ROOTS = [{ name: "files", storagePath: "/data", indexerPath: "/data" }];

function index(rootIds: Record<string, number> = { files: 3 }) {
  return {
    rootIdsByName: vi.fn(async () => rootIds),
    subtreeSize: vi.fn(async () => ({ bytes: 1_234, files: 2 })),
  };
}

describe("createHomeUsage", () => {
  it("sums everything the index holds in the user's home", async () => {
    const queries = index();
    const usage = createHomeUsage({ fdriveStorageRoot: "/data", fdriveIndexRoots: ROOTS }, queries);
    expect(await usage("alice")).toBe(1_234);
    expect(queries.subtreeSize).toHaveBeenCalledWith(
      [{ rootId: 3, fsPrefix: "/alice" }],
      3,
      "alice",
    );
  });

  it("is null without a files folder or an index root for it, without asking the index", async () => {
    const queries = index();
    const noFolder = createHomeUsage(
      { fdriveStorageRoot: undefined, fdriveIndexRoots: ROOTS },
      queries,
    );
    const noRoots = createHomeUsage(
      { fdriveStorageRoot: "/data", fdriveIndexRoots: null },
      queries,
    );
    expect(await noFolder("alice")).toBeNull();
    expect(await noRoots("alice")).toBeNull();
    expect(queries.rootIdsByName).not.toHaveBeenCalled();
  });

  it("is null until the indexer has created the root", async () => {
    const queries = index({});
    const usage = createHomeUsage({ fdriveStorageRoot: "/data", fdriveIndexRoots: ROOTS }, queries);
    expect(await usage("alice")).toBeNull();
    expect(queries.subtreeSize).not.toHaveBeenCalled();
  });
});
