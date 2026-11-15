import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { batchRenameName, planBatchRename } from "./batch-rename";

function entry(path: string, kind: FsEntry["kind"] = "file"): FsEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, kind, size: 0, ext: "", mime: null, modifiedAt: "2026-01-01T00:00:00.000Z" };
}

describe("batchRenameName", () => {
  it("replaces every case-sensitive match of the find text", () => {
    const rule = { mode: "replace", find: "IMG", replace: "Trip" } as const;
    expect(batchRenameName(entry("/a/IMG_1 IMG.jpg"), 0, rule)).toBe("Trip_1 Trip.jpg");
    expect(batchRenameName(entry("/a/img_2.jpg"), 1, rule)).toBe("img_2.jpg");
  });

  it("numbers from 1 and keeps a file's extension but not a folder's dot", () => {
    const rule = { mode: "number", base: " Trip " } as const;
    expect(batchRenameName(entry("/a/IMG_1.JPG"), 0, rule)).toBe("Trip 1.JPG");
    expect(batchRenameName(entry("/a/notes"), 1, rule)).toBe("Trip 2");
    expect(batchRenameName(entry("/a/v1.2", "dir"), 2, rule)).toBe("Trip 3");
  });

  it("keeps the name while the rule is still empty", () => {
    expect(batchRenameName(entry("/a/x.txt"), 0, { mode: "replace", find: "", replace: "y" })).toBe(
      "x.txt",
    );
    expect(batchRenameName(entry("/a/x.txt"), 0, { mode: "number", base: "  " })).toBe("x.txt");
  });
});

describe("planBatchRename", () => {
  const a = entry("/f/a.txt");
  const b = entry("/f/b.txt");
  const c = entry("/f/c.txt");

  it("is ready when names change without colliding", () => {
    const plan = planBatchRename([a, b], { mode: "number", base: "Doc" }, [a, b, c]);
    expect(plan.rows.map((row) => row.newName)).toEqual(["Doc 1.txt", "Doc 2.txt"]);
    expect(plan.changes.map((row) => row.path)).toEqual(["/f/a.txt", "/f/b.txt"]);
    expect(plan.ready).toBe(true);
  });

  it("is not ready when nothing changes, and only sends rows that change", () => {
    expect(
      planBatchRename([a, b], { mode: "replace", find: "z", replace: "y" }, [a, b]).ready,
    ).toBe(false);
    const plan = planBatchRename([a, b], { mode: "replace", find: "a", replace: "d" }, [a, b]);
    expect(plan.changes.map((row) => row.newName)).toEqual(["d.txt"]);
    expect(plan.ready).toBe(true);
  });

  it("flags a new name already taken in the folder", () => {
    const plan = planBatchRename([a, b], { mode: "replace", find: "a", replace: "c" }, [a, b, c]);
    expect(plan.rows.map((row) => row.collides)).toEqual([true, false]);
    expect(plan.ready).toBe(false);
  });

  it("flags two rows that would get the same name", () => {
    const plan = planBatchRename([a, b], { mode: "replace", find: ".txt", replace: "" }, [a, b]);
    expect(plan.rows.map((row) => row.collides)).toEqual([false, false]);
    const same = planBatchRename([a, b], { mode: "replace", find: "a", replace: "b" }, [a, b]);
    expect(same.rows.map((row) => row.collides)).toEqual([true, false]);
    const twin = planBatchRename(
      [entry("/f/a1.txt"), entry("/f/a2.txt")],
      { mode: "replace", find: "a2", replace: "a1" },
      [],
    );
    expect(twin.rows.map((row) => row.collides)).toEqual([false, true]);
  });

  it("only compares names within the same folder", () => {
    const nested = entry("/f/sub/a.txt");
    const plan = planBatchRename([a, nested], { mode: "replace", find: "a", replace: "c" }, [
      a,
      c,
      nested,
    ]);
    expect(plan.rows.map((row) => row.collides)).toEqual([true, false]);
  });
});
