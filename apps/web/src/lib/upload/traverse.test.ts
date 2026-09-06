import { describe, expect, it } from "vitest";
import {
  collectDroppedFiles,
  collectInputFiles,
  type DataTransferItemLike,
  type DataTransferLike,
  type EntryLike,
  type EntryReaderLike,
} from "./traverse.js";

function fileEntry(name: string, file: File): EntryLike {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (success) => success(file),
  };
}

function dirEntry(name: string, batches: EntryLike[][]): EntryLike {
  let call = 0;
  const reader: EntryReaderLike = {
    readEntries: (success) => {
      const batch = batches[call] ?? [];
      call++;
      success(batch);
    },
  };
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => reader,
  };
}

function itemFor(entry: EntryLike): DataTransferItemLike {
  return { kind: "file", webkitGetAsEntry: () => entry };
}

function dataTransferFromItems(
  items: DataTransferItemLike[],
  files: File[] = [],
): DataTransferLike {
  return { items, files };
}

describe("collectDroppedFiles", () => {
  it("collects flat files at the top level", async () => {
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    const dt = dataTransferFromItems([
      itemFor(fileEntry("a.txt", a)),
      itemFor(fileEntry("b.txt", b)),
    ]);

    const result = await collectDroppedFiles(dt);
    expect(result).toEqual([
      { file: a, relativePath: "a.txt" },
      { file: b, relativePath: "b.txt" },
    ]);
  });

  it("walks nested directories, building relative paths", async () => {
    const inner = new File(["x"], "inner.txt");
    const nested = dirEntry("nested", [[fileEntry("inner.txt", inner)]]);
    const outer = dirEntry("folder", [[nested]]);
    const dt = dataTransferFromItems([itemFor(outer)]);

    const result = await collectDroppedFiles(dt);
    expect(result).toEqual([{ file: inner, relativePath: "folder/nested/inner.txt" }]);
  });

  it("calls readEntries repeatedly until an empty batch is returned", async () => {
    const files = [new File(["1"], "1.txt"), new File(["2"], "2.txt"), new File(["3"], "3.txt")];
    const dir = dirEntry("many", [
      [fileEntry("1.txt", files[0] as File), fileEntry("2.txt", files[1] as File)],
      [fileEntry("3.txt", files[2] as File)],
      [],
    ]);
    const dt = dataTransferFromItems([itemFor(dir)]);

    const result = await collectDroppedFiles(dt);
    expect(result.map((r) => r.relativePath)).toEqual(["many/1.txt", "many/2.txt", "many/3.txt"]);
  });

  it("skips .DS_Store and Thumbs.db at any depth", async () => {
    const keep = new File(["k"], "keep.txt");
    const dsStore = fileEntry(".DS_Store", new File(["."], ".DS_Store"));
    const thumbs = fileEntry("Thumbs.db", new File(["."], "Thumbs.db"));
    const dir = dirEntry("folder", [[dsStore, thumbs, fileEntry("keep.txt", keep)]]);
    const dt = dataTransferFromItems([itemFor(dir)]);

    const result = await collectDroppedFiles(dt);
    expect(result).toEqual([{ file: keep, relativePath: "folder/keep.txt" }]);
  });

  it("ignores non-file drag items", async () => {
    const dt = dataTransferFromItems([{ kind: "string" }]);
    expect(await collectDroppedFiles(dt)).toEqual([]);
  });

  it("skips a non-file item that sits alongside a file item with entry support", async () => {
    const a = new File(["a"], "a.txt");
    const dt = dataTransferFromItems([{ kind: "string" }, itemFor(fileEntry("a.txt", a))]);
    expect(await collectDroppedFiles(dt)).toEqual([{ file: a, relativePath: "a.txt" }]);
  });

  it("ignores an item whose entry resolves to null", async () => {
    const dt = dataTransferFromItems([{ kind: "file", webkitGetAsEntry: () => null }]);
    expect(await collectDroppedFiles(dt)).toEqual([]);
  });

  it("falls back to the flat file list when entries are unsupported", async () => {
    const a = new File(["a"], "a.txt");
    const dsStore = new File(["."], ".DS_Store");
    const dt: DataTransferLike = { files: [a, dsStore] };

    const result = await collectDroppedFiles(dt);
    expect(result).toEqual([{ file: a, relativePath: "a.txt" }]);
  });

  it("falls back to the flat file list when items is empty", async () => {
    const a = new File(["a"], "a.txt");
    const dt: DataTransferLike = { items: [], files: [a] };
    expect(await collectDroppedFiles(dt)).toEqual([{ file: a, relativePath: "a.txt" }]);
  });

  it("rejects when a file entry has no file() method", async () => {
    const dt = dataTransferFromItems([
      itemFor({ name: "broken.txt", isFile: true, isDirectory: false }),
    ]);
    await expect(collectDroppedFiles(dt)).rejects.toThrow();
  });

  it("does not recurse into a directory entry without a reader", async () => {
    const dt = dataTransferFromItems([
      itemFor({ name: "empty-dir", isFile: false, isDirectory: true }),
    ]);
    expect(await collectDroppedFiles(dt)).toEqual([]);
  });
});

describe("collectInputFiles", () => {
  it("uses webkitRelativePath when present", () => {
    const file = new File(["x"], "b.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "folder/b.txt" });
    const result = collectInputFiles([file]);
    expect(result).toEqual([{ file, relativePath: "folder/b.txt" }]);
  });

  it("falls back to the bare file name without webkitRelativePath", () => {
    const file = new File(["x"], "a.txt");
    const result = collectInputFiles([file]);
    expect(result).toEqual([{ file, relativePath: "a.txt" }]);
  });

  it("skips ignored file names", () => {
    const ok = new File(["x"], "keep.txt");
    const ds = new File(["."], ".DS_Store");
    expect(collectInputFiles([ok, ds])).toEqual([{ file: ok, relativePath: "keep.txt" }]);
  });
});
