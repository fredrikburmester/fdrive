import { describe, expect, it } from "vitest";
import { planUploads } from "./plan.js";
import type { DroppedFile } from "./traverse.js";

function idGen(): () => string {
  let n = 0;
  return () => `id-${n++}`;
}

function dropped(relativePath: string, content = "x"): DroppedFile {
  const name = relativePath.split("/").pop() ?? relativePath;
  return { file: new File([content], name), relativePath };
}

describe("planUploads", () => {
  it("targets every file at destination and marks nothing as conflicting when there is none", () => {
    const files = [dropped("a.txt"), dropped("folder/b.txt")];
    const { items, conflicts } = planUploads(files, "/dest", new Set(), "ask", idGen());

    expect(conflicts).toEqual([]);
    expect(items).toEqual([
      expect.objectContaining({
        targetPath: "/dest/a.txt",
        relativePath: "a.txt",
        status: "queued",
        size: 1,
        progress: 0,
        attempts: 0,
      }),
      expect.objectContaining({
        targetPath: "/dest/folder/b.txt",
        relativePath: "folder/b.txt",
        status: "queued",
      }),
    ]);
  });

  it("assigns a unique id from createId to every item", () => {
    const files = [dropped("a.txt"), dropped("b.txt")];
    const { items } = planUploads(files, "/dest", new Set(), "ask", idGen());
    expect(items[0]?.id).not.toBe(items[1]?.id);
  });

  it("detects conflicts by top-level name only, deduped", () => {
    const files = [dropped("folder/a.txt"), dropped("folder/b.txt"), dropped("other.txt")];
    const { conflicts } = planUploads(files, "/dest", new Set(["folder"]), "ask", idGen());
    expect(conflicts).toEqual(["folder"]);
  });

  it("under 'skip', marks conflicting items skipped and leaves the rest queued", () => {
    const files = [dropped("dup.txt"), dropped("clean.txt")];
    const { items, conflicts } = planUploads(files, "/dest", new Set(["dup.txt"]), "skip", idGen());
    expect(conflicts).toEqual(["dup.txt"]);
    expect(items.find((i) => i.relativePath === "dup.txt")?.status).toBe("skipped");
    expect(items.find((i) => i.relativePath === "clean.txt")?.status).toBe("queued");
  });

  it("under 'replace', keeps conflicting items queued", () => {
    const files = [dropped("dup.txt")];
    const { items, conflicts } = planUploads(
      files,
      "/dest",
      new Set(["dup.txt"]),
      "replace",
      idGen(),
    );
    expect(conflicts).toEqual(["dup.txt"]);
    expect(items[0]?.status).toBe("queued");
  });

  it("returns no items for an empty file list", () => {
    const { items, conflicts } = planUploads([], "/dest", new Set(), "ask", idGen());
    expect(items).toEqual([]);
    expect(conflicts).toEqual([]);
  });
});
