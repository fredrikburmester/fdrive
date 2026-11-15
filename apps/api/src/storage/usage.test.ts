import { describe, expect, it, vi } from "vitest";
import { createHomeUsage } from "./usage.js";

function index() {
  return { subtreeSize: vi.fn(async () => ({ bytes: 1_234, files: 2 })) };
}

describe("createHomeUsage", () => {
  it("sums everything the index holds in the user's home", async () => {
    const queries = index();
    const usage = createHomeUsage(queries, async () => true);
    expect(await usage("alice")).toBe(1_234);
    expect(queries.subtreeSize).toHaveBeenCalledWith(
      [{ rootId: 1, fsPrefix: "/alice" }],
      1,
      "alice",
    );
  });

  it("is null while the files folder is not indexed, without asking the index", async () => {
    const queries = index();
    const usage = createHomeUsage(queries, async () => false);
    expect(await usage("alice")).toBeNull();
    expect(queries.subtreeSize).not.toHaveBeenCalled();
  });
});
