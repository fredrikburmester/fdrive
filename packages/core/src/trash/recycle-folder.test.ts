import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSafeSegment, normalizePath } from "../paths.ts";
import {
  isInMoveTrashLayout,
  isUnderPath,
  moveTrashLeafPath,
  moveTrashRootPath,
  parseMoveTrashLeaf,
  trashLeafPath,
} from "./recycle-folder.ts";

describe("isUnderPath", () => {
  it("is true for a path nested below the prefix", () => {
    expect(isUnderPath("/.trash", "/.trash/docs/a.txt/123")).toBe(true);
  });

  it("is false for the prefix itself", () => {
    expect(isUnderPath("/.trash", "/.trash")).toBe(false);
  });

  it("is false for a sibling with a shared string prefix", () => {
    expect(isUnderPath("/.trash", "/.trashcan/x")).toBe(false);
  });

  it("is true for any non-root path when the prefix is the root", () => {
    expect(isUnderPath("/", "/anything")).toBe(true);
  });

  it("is false for the root itself when the prefix is the root", () => {
    expect(isUnderPath("/", "/")).toBe(false);
  });
});

describe("isInMoveTrashLayout", () => {
  it("finds the layout under any folder, in any case, whatever Trash is set to", () => {
    for (const path of [
      "/.trash/.fdrive-move-v1",
      "/.trash/.fdrive-move-v1/dir/p/a/v/1/b.txt",
      "/old bin/.FDRIVE-MOVE-V1/file/p/a/v/1",
    ])
      expect(isInMoveTrashLayout(path), path).toBe(true);
    for (const path of ["/", "/.trash", "/a/.fdrive-move-v1x", "/a/fdrive-move-v1"])
      expect(isInMoveTrashLayout(path), path).toBe(false);
  });
});

describe("trashLeafPath", () => {
  it("joins the trash root and the id", () => {
    expect(trashLeafPath("/.trash", "docs/a.txt/123")).toBe("/.trash/docs/a.txt/123");
  });

  it("normalizes the trash root's trailing slash", () => {
    expect(trashLeafPath("/.trash/", "top.txt/123")).toBe("/.trash/top.txt/123");
  });
});

describe("generic move layout", () => {
  it("keeps raw path segments in unambiguous structural pairs", () => {
    const leaf = moveTrashLeafPath("/.trash", "/docs/p/v/2026", "dir", "123");
    expect(leaf).toBe("/.trash/.fdrive-move-v1/dir/p/docs/p/p/p/v/p/2026/v/123");
    expect(moveTrashRootPath("/.trash/")).toBe("/.trash/.fdrive-move-v1");
  });

  it("parses the original path, kind, and timestamp", () => {
    const leaf = moveTrashLeafPath("/.trash", "/docs/2026/Å %20.txt", "file", "1000000");

    expect(parseMoveTrashLeaf("/.trash", leaf)).toEqual({
      kind: "file",
      originalPath: "/docs/2026/Å %20.txt",
      name: "Å %20.txt",
      deletedAt: new Date(1),
    });
  });

  it("round-trips a maximum-length segment without expanding it", () => {
    const segment = "x".repeat(255);
    const leaf = moveTrashLeafPath("/.trash", `/${segment}`, "dir", "1000000");

    expect(leaf).toContain(`/p/${segment}/v/1000000`);
    expect(parseMoveTrashLeaf("/.trash", leaf)?.originalPath).toBe(`/${segment}`);
  });

  it("rejects paths outside the namespace and malformed structural paths", () => {
    for (const path of [
      "/.trash/docs/a.txt/123",
      "/.trash/.fdrive-move-v1/other/p/docs/v/123",
      "/.trash/.fdrive-move-v1/file/docs/v/123",
      "/.trash/.fdrive-move-v1/file/x/docs/v/123",
      "/.trash/.fdrive-move-v1/file/p/docs/x/123",
      "/.trash/.fdrive-move-v1/file/p/docs/v/not-a-time",
      "/.trash/.fdrive-move-v1/file/v/123",
    ]) {
      expect(parseMoveTrashLeaf("/.trash", path)).toBeNull();
    }
  });
});

describe("parseMoveTrashLeaf timestamps", () => {
  const at = (timestamp: string) => moveTrashLeafPath("/.trash", "/top.txt", "file", timestamp);

  it("truncates the nanosecond timestamp toward zero milliseconds", () => {
    expect(parseMoveTrashLeaf("/.trash", at("1999999"))?.deletedAt).toEqual(new Date(1));
  });

  it("accepts a 1- to 20-digit leaf name", () => {
    expect(parseMoveTrashLeaf("/.trash", at("5"))).not.toBeNull();
    expect(parseMoveTrashLeaf("/.trash", at("1".repeat(20)))).not.toBeNull();
  });

  it("rejects a 21-digit leaf name", () => {
    expect(parseMoveTrashLeaf("/.trash", at("1".repeat(21)))).toBeNull();
  });

  it("rejects the namespace itself and a path outside the trash folder", () => {
    expect(parseMoveTrashLeaf("/.trash", "/.trash/.fdrive-move-v1")).toBeNull();
    expect(parseMoveTrashLeaf("/.trash", "/docs/.fdrive-move-v1/file/p/a/v/1")).toBeNull();
  });
});

describe("moveTrashLeafPath and parseMoveTrashLeaf round trip", () => {
  it("recovers the same kind, originalPath, name, and millisecond-truncated deletedAt for any path", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string().filter(isSafeSegment), { minLength: 0, maxLength: 4 }),
        fc.string().filter(isSafeSegment),
        fc.constantFrom("file" as const, "dir" as const),
        fc.bigInt({ min: 1n, max: 99999999999999999n }),
        (dirSegments, name, kind, ns) => {
          const trashPath = "/.trash";
          const originalPath = normalizePath(`/${[...dirSegments, name].join("/")}`);
          const leafPath = moveTrashLeafPath(trashPath, originalPath, kind, ns.toString());
          const id = leafPath.slice(`${trashPath}/`.length);

          const parsed = parseMoveTrashLeaf(trashPath, trashLeafPath(trashPath, id));

          expect(parsed).toEqual({
            kind,
            originalPath,
            name,
            deletedAt: new Date(Number(ns / 1_000_000n)),
          });
        },
      ),
    );
  });
});
