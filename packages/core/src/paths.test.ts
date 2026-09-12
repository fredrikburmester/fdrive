import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isCoreError } from "./errors.ts";
import {
  baseName,
  changeBaseName,
  extensionOf,
  isRoot,
  isSafeSegment,
  isWithin,
  joinPath,
  normalizePath,
  parentPath,
  relativeTo,
  splitSegments,
} from "./paths.ts";

describe("normalizePath", () => {
  it("treats '' and '/' both as the root", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
  });

  it("adds a missing leading slash", () => {
    expect(normalizePath("a/b")).toBe("/a/b");
  });

  it("collapses repeated slashes", () => {
    expect(normalizePath("/a//b///c")).toBe("/a/b/c");
  });

  it("drops '.' segments", () => {
    expect(normalizePath("/a/./b/.")).toBe("/a/b");
  });

  it("resolves '..' without ever escaping the root", () => {
    expect(normalizePath("/a/../../b")).toBe("/b");
    expect(normalizePath("/../../..")).toBe("/");
    expect(normalizePath("/a/b/..")).toBe("/a");
  });

  it("strips the trailing slash except for the root", () => {
    expect(normalizePath("/a/b/")).toBe("/a/b");
    expect(normalizePath("/")).toBe("/");
  });

  it("treats backslashes as ordinary characters", () => {
    expect(normalizePath("/a\\b/c")).toBe("/a\\b/c");
  });

  it("throws invalid_path on a NUL byte", () => {
    expect(() => normalizePath("/a\0b")).toThrow(/NUL/);
    try {
      normalizePath("/a\0b");
      expect.fail("should have thrown");
    } catch (error) {
      expect(isCoreError(error)).toBe(true);
      expect(isCoreError(error) && error.kind).toBe("invalid_path");
    }
  });

  it("throws invalid_path on a segment over 255 UTF-8 bytes", () => {
    const longSegment = "a".repeat(256);
    expect(() => normalizePath(`/${longSegment}`)).toThrow(/255 bytes/);

    // A multi-byte character makes the byte length exceed 255 well before
    // the character count does.
    const multiByteSegment = "\u{1F600}".repeat(64); // 4 bytes each = 256 bytes
    expect(() => normalizePath(`/${multiByteSegment}`)).toThrow(/255 bytes/);
  });

  it("accepts a segment at exactly 255 UTF-8 bytes", () => {
    const segment = "a".repeat(255);
    expect(normalizePath(`/${segment}`)).toBe(`/${segment}`);
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        let once: string;
        try {
          once = normalizePath(input);
        } catch {
          return; // inputs that throw are not part of this property
        }
        expect(normalizePath(once)).toBe(once);
      }),
    );
  });

  it("never produces '..' segments", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        let normalized: string;
        try {
          normalized = normalizePath(input);
        } catch {
          return;
        }
        expect(splitSegments(normalized)).not.toContain("..");
        expect(splitSegments(normalized)).not.toContain(".");
      }),
    );
  });
});

describe("joinPath", () => {
  it("joins and normalizes", () => {
    expect(joinPath("/a", "b", "c")).toBe("/a/b/c");
  });

  it("normalizes traversal introduced by a segment", () => {
    expect(joinPath("/a/b", "..", "c")).toBe("/a/c");
  });

  it("works with no extra segments", () => {
    expect(joinPath("/a/b")).toBe("/a/b");
  });
});

describe("splitSegments", () => {
  it("returns [] for the root", () => {
    expect(splitSegments("/")).toEqual([]);
    expect(splitSegments("")).toEqual([]);
  });

  it("splits a nested path", () => {
    expect(splitSegments("/a/b/c")).toEqual(["a", "b", "c"]);
  });
});

describe("parentPath", () => {
  it("is '/' for the root", () => {
    expect(parentPath("/")).toBe("/");
  });

  it("is '/' for a top-level entry", () => {
    expect(parentPath("/a")).toBe("/");
  });

  it("is the enclosing directory otherwise", () => {
    expect(parentPath("/a/b/c")).toBe("/a/b");
  });
});

describe("baseName", () => {
  it("is '' for the root", () => {
    expect(baseName("/")).toBe("");
    expect(baseName("")).toBe("");
  });

  it("is the final segment otherwise", () => {
    expect(baseName("/a/b/c")).toBe("c");
    expect(baseName("/a")).toBe("a");
  });
});

describe("isRoot", () => {
  it("is true for the root in any spelling", () => {
    expect(isRoot("/")).toBe(true);
    expect(isRoot("")).toBe(true);
    expect(isRoot("/a/..")).toBe(true);
  });

  it("is false otherwise", () => {
    expect(isRoot("/a")).toBe(false);
  });
});

describe("isWithin", () => {
  it("is true when child equals parent", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
  });

  it("is true when child is nested below parent", () => {
    expect(isWithin("/a", "/a/b/c")).toBe(true);
  });

  it("is true for anything when parent is the root", () => {
    expect(isWithin("/", "/anything/deep")).toBe(true);
    expect(isWithin("/", "/")).toBe(true);
  });

  it("is false when child is outside parent", () => {
    expect(isWithin("/a/b", "/a/c")).toBe(false);
  });

  it("is false for a sibling with a shared string prefix", () => {
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
  });

  it("holds for joinPath(parent, seg) with any safe segment", () => {
    fc.assert(
      fc.property(
        fc.string().filter((p) => {
          try {
            normalizePath(p);
            return true;
          } catch {
            return false;
          }
        }),
        fc.string().filter(isSafeSegment),
        (parent, seg) => {
          const normalizedParent = normalizePath(parent);
          expect(isWithin(normalizedParent, joinPath(normalizedParent, seg))).toBe(true);
        },
      ),
    );
  });
});

describe("relativeTo", () => {
  it("is '' when parent and child are equal", () => {
    expect(relativeTo("/a/b", "/a/b")).toBe("");
  });

  it("is the remaining segments otherwise", () => {
    expect(relativeTo("/a", "/a/b/c")).toBe("b/c");
  });

  it("is the full path (without leading slash) when parent is the root", () => {
    expect(relativeTo("/", "/a/b")).toBe("a/b");
  });

  it("is null when child is outside parent", () => {
    expect(relativeTo("/a/b", "/a/c")).toBeNull();
    expect(relativeTo("/a/b", "/x")).toBeNull();
  });
});

describe("extensionOf", () => {
  it("returns '' for a name with no dot", () => {
    expect(extensionOf("README")).toBe("");
  });

  it("returns '' for a dotfile", () => {
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });

  it("returns the lowercase extension", () => {
    expect(extensionOf("Photo.JPG")).toBe(".jpg");
    expect(extensionOf("archive.zip")).toBe(".zip");
  });

  it("special-cases compound archive extensions", () => {
    expect(extensionOf("backup.tar.gz")).toBe(".tar.gz");
    expect(extensionOf("backup.TAR.GZ")).toBe(".tar.gz");
    expect(extensionOf("backup.tar.bz2")).toBe(".tar.bz2");
    expect(extensionOf("backup.tar.xz")).toBe(".tar.xz");
    expect(extensionOf("backup.tar.zst")).toBe(".tar.zst");
  });

  it("falls back to the plain last-dot rule when the name is only the compound suffix itself", () => {
    // ".tar.gz" has two dots, so it is not a single-dot dotfile: the last
    // dot still wins, same as it would for any other multi-dot name.
    expect(extensionOf(".tar.gz")).toBe(".gz");
  });

  it("falls back to the last dot when there is no compound match", () => {
    expect(extensionOf("archive.gz")).toBe(".gz");
  });
});

describe("isSafeSegment", () => {
  it("accepts an ordinary segment", () => {
    expect(isSafeSegment("photos")).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isSafeSegment("")).toBe(false);
  });

  it("rejects a segment containing '/'", () => {
    expect(isSafeSegment("a/b")).toBe(false);
  });

  it("rejects a segment containing a NUL byte", () => {
    expect(isSafeSegment("a\0b")).toBe(false);
  });

  it("rejects '.' and '..'", () => {
    expect(isSafeSegment(".")).toBe(false);
    expect(isSafeSegment("..")).toBe(false);
  });
});

describe("changeBaseName", () => {
  it("replaces the final segment", () => {
    expect(changeBaseName("/a/b/old.txt", "new.txt")).toBe("/a/b/new.txt");
  });

  it("throws invalid_argument for an unsafe name", () => {
    expect(() => changeBaseName("/a/b", "..")).toThrow(/safe/);
    try {
      changeBaseName("/a/b", "x/y");
      expect.fail("should have thrown");
    } catch (error) {
      expect(isCoreError(error) && error.kind).toBe("invalid_argument");
    }
  });
});

it("rejects overlong UTF-8 entry names before joining", () => {
  expect(isSafeSegment(`${"é".repeat(127)}a`)).toBe(true);
  expect(isSafeSegment("é".repeat(128))).toBe(false);
  expect(() => changeBaseName("/old", "é".repeat(128))).toThrow("safe path segment");
});
