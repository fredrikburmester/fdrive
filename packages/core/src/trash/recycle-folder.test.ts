import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSafeSegment, normalizePath } from "../paths.ts";
import {
  isUnderPath,
  moveTrashLeafPath,
  moveTrashRootPath,
  parseMoveTrashLeaf,
  parseTrashLeaf,
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

describe("parseTrashLeaf", () => {
  it("parses a top-level file's leaf", () => {
    const parsed = parseTrashLeaf("/.trash", "/.trash/top.txt/1788761221798866471");
    expect(parsed).not.toBeNull();
    expect(parsed?.originalPath).toBe("/top.txt");
    expect(parsed?.name).toBe("top.txt");
  });

  it("parses a nested file's leaf, keeping every directory segment in originalPath", () => {
    const parsed = parseTrashLeaf("/.trash", "/.trash/docs/sub/a.txt/1788761221798866471");
    expect(parsed?.originalPath).toBe("/docs/sub/a.txt");
    expect(parsed?.name).toBe("a.txt");
  });

  it("computes deletedAt by truncating the nanosecond timestamp to milliseconds", () => {
    const parsed = parseTrashLeaf("/.trash", "/.trash/top.txt/1000000");
    expect(parsed?.deletedAt).toEqual(new Date(1));
  });

  it("truncates sub-millisecond precision toward zero", () => {
    const parsed = parseTrashLeaf("/.trash", "/.trash/top.txt/1999999");
    expect(parsed?.deletedAt).toEqual(new Date(1));
  });

  it("accepts a single-digit leaf name", () => {
    expect(parseTrashLeaf("/.trash", "/.trash/top.txt/5")).not.toBeNull();
  });

  it("accepts a 20-digit leaf name", () => {
    expect(parseTrashLeaf("/.trash", `/.trash/top.txt/${"1".repeat(20)}`)).not.toBeNull();
  });

  it("rejects a 21-digit leaf name", () => {
    expect(parseTrashLeaf("/.trash", `/.trash/top.txt/${"1".repeat(21)}`)).toBeNull();
  });

  it("rejects a leaf name that is not all digits", () => {
    expect(parseTrashLeaf("/.trash", "/.trash/top.txt/12ab")).toBeNull();
  });

  it("rejects a path outside the trash root", () => {
    expect(parseTrashLeaf("/.trash", "/docs/top.txt/123")).toBeNull();
  });

  it("rejects the trash root itself", () => {
    expect(parseTrashLeaf("/.trash", "/.trash")).toBeNull();
  });

  it("rejects a leaf with no original-name segment above it", () => {
    expect(parseTrashLeaf("/.trash", "/.trash/123")).toBeNull();
  });

  it("round-trips a name with spaces, Unicode, and a literal percent sequence", () => {
    const parsed = parseTrashLeaf("/.trash", "/.trash/docs/sp ace %20 Å.txt/1788761221798866471");
    expect(parsed?.originalPath).toBe("/docs/sp ace %20 Å.txt");
    expect(parsed?.name).toBe("sp ace %20 Å.txt");
  });
});

describe("parseTrashLeaf and trashLeafPath round trip", () => {
  it("recovers the same originalPath, name, and millisecond-truncated deletedAt for any well-formed leaf", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string().filter(isSafeSegment), { minLength: 0, maxLength: 4 }),
        fc.string().filter(isSafeSegment),
        fc.bigInt({ min: 1n, max: 99999999999999999n }),
        (dirSegments, name, ns) => {
          const trashPath = "/.trash";
          const originalPath = normalizePath(`/${[...dirSegments, name].join("/")}`);
          const id = `${originalPath.slice(1)}/${ns}`;
          const leafPath = trashLeafPath(trashPath, id);

          const parsed = parseTrashLeaf(trashPath, leafPath);

          expect(parsed).not.toBeNull();
          expect(parsed?.originalPath).toBe(originalPath);
          expect(parsed?.name).toBe(name);
          expect(parsed?.deletedAt).toEqual(new Date(Number(ns / 1_000_000n)));
        },
      ),
    );
  });
});
