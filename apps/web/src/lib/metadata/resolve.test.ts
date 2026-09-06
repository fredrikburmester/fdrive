import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { resolveEntries } from "./resolve";

function entry(path: string): FsEntry {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    kind: "file",
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
  };
}

describe("resolveEntries", () => {
  it("returns an empty array for no paths", async () => {
    const result = await resolveEntries([], async (path) => entry(path));
    expect(result).toEqual([]);
  });

  it("resolves every path in input order", async () => {
    const result = await resolveEntries(["/a", "/b", "/c"], async (path) => entry(path));
    expect(result.map((r) => r.path)).toEqual(["/a", "/b", "/c"]);
    expect(result.every((r) => r.entry !== null)).toBe(true);
  });

  it("maps a rejected stat to a null entry instead of failing the batch", async () => {
    const result = await resolveEntries(["/a", "/missing", "/c"], async (path) => {
      if (path === "/missing") {
        throw new Error("not found");
      }
      return entry(path);
    });
    expect(result).toEqual([
      { path: "/a", entry: entry("/a") },
      { path: "/missing", entry: null },
      { path: "/c", entry: entry("/c") },
    ]);
  });

  it("never runs more than `concurrency` stats at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const paths = Array.from({ length: 10 }, (_, index) => `/f${index}`);

    await resolveEntries(
      paths,
      async (path) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
        inFlight -= 1;
        return entry(path);
      },
      3,
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("clamps concurrency to at least 1 and returns results in order even with a huge concurrency", async () => {
    const result = await resolveEntries(["/a", "/b"], async (path) => entry(path), 0);
    expect(result.map((r) => r.path)).toEqual(["/a", "/b"]);

    const result2 = await resolveEntries(["/a", "/b"], async (path) => entry(path), 100);
    expect(result2.map((r) => r.path)).toEqual(["/a", "/b"]);
  });
});
