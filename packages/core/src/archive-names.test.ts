import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  archiveExtensionFor,
  defaultArchiveName,
  detectArchiveKind,
  isPeekableArchiveName,
  safeEntryPath,
  stripArchiveExtension,
  uniqueCopyName,
  uniqueNumberedName,
} from "./archive-names.ts";
import { isWithin, normalizePath } from "./paths.ts";

describe("uniqueCopyName", () => {
  it("appends ' copy' before the extension when there is no collision", () => {
    expect(uniqueCopyName("report.pdf", new Set())).toBe("report copy.pdf");
  });

  it("numbers subsequent copies starting at 2", () => {
    const existing = new Set(["report.pdf", "report copy.pdf"]);
    expect(uniqueCopyName("report.pdf", existing)).toBe("report copy 2.pdf");
  });

  it("keeps incrementing past an existing numbered copy", () => {
    const existing = new Set(["report.pdf", "report copy.pdf", "report copy 2.pdf"]);
    expect(uniqueCopyName("report.pdf", existing)).toBe("report copy 3.pdf");
  });

  it("handles names with no extension (folders)", () => {
    expect(uniqueCopyName("docs", new Set())).toBe("docs copy");
    expect(uniqueCopyName("docs", new Set(["docs copy"]))).toBe("docs copy 2");
  });

  it("handles dotfiles, which have no extension", () => {
    expect(uniqueCopyName(".env", new Set())).toBe(".env copy");
    expect(uniqueCopyName(".env", new Set([".env copy"]))).toBe(".env copy 2");
  });

  it("preserves a compound archive extension", () => {
    expect(uniqueCopyName("backup.tar.gz", new Set())).toBe("backup copy.tar.gz");
  });

  it("tolerates a gap in the numbered sequence", () => {
    const existing = new Set(["a.txt", "a copy.txt", "a copy 2.txt", "a copy 3.txt"]);
    expect(uniqueCopyName("a.txt", existing)).toBe("a copy 4.txt");
  });
});

describe("uniqueNumberedName", () => {
  it("keeps a free name", () => {
    expect(uniqueNumberedName("report.pdf", new Set(["other.pdf"]))).toBe("report.pdf");
  });

  it("numbers a taken name from 2, before the extension", () => {
    expect(uniqueNumberedName("report.pdf", new Set(["report.pdf"]))).toBe("report (2).pdf");
    const taken = new Set(["report.pdf", "report (2).pdf", "report (3).pdf"]);
    expect(uniqueNumberedName("report.pdf", taken)).toBe("report (4).pdf");
  });

  it("handles folders, dotfiles and compound extensions", () => {
    expect(uniqueNumberedName("docs", new Set(["docs"]))).toBe("docs (2)");
    expect(uniqueNumberedName(".env", new Set([".env"]))).toBe(".env (2)");
    expect(uniqueNumberedName("backup.tar.gz", new Set(["backup.tar.gz"]))).toBe(
      "backup (2).tar.gz",
    );
  });
});

describe("archiveExtensionFor", () => {
  it("maps each format to its extension", () => {
    expect(archiveExtensionFor("zip")).toBe(".zip");
    expect(archiveExtensionFor("tar.gz")).toBe(".tar.gz");
    expect(archiveExtensionFor("tar.zst")).toBe(".tar.zst");
  });
});

describe("stripArchiveExtension", () => {
  it.each([
    ["archive.zip", "archive"],
    ["backup.tar.gz", "backup"],
    ["backup.tgz", "backup"],
    ["backup.tar.zst", "backup"],
    ["dump.tar", "dump"],
    ["file.gz", "file"],
    ["ARCHIVE.ZIP", "ARCHIVE"],
  ])("strips %s to %s", (input, expected) => {
    expect(stripArchiveExtension(input)).toBe(expected);
  });

  it("leaves a name with no recognized suffix unchanged", () => {
    expect(stripArchiveExtension("notes.txt")).toBe("notes.txt");
  });

  it("does not strip a suffix that would leave nothing behind", () => {
    expect(stripArchiveExtension(".zip")).toBe(".zip");
  });

  it("prefers the longest matching compound suffix", () => {
    expect(stripArchiveExtension("my.tar.gz")).toBe("my");
  });
});

describe("detectArchiveKind", () => {
  it.each([
    ["a.zip", "zip"],
    ["a.tar", "tar"],
    ["a.tar.gz", "tar.gz"],
    ["a.tgz", "tar.gz"],
    ["a.tar.zst", "tar.zst"],
    ["a.gz", "gz"],
    ["A.ZIP", "zip"],
  ] as const)("detects %s as %s", (input, expected) => {
    expect(detectArchiveKind(input)).toBe(expected);
  });

  it("returns null for an unrecognized extension", () => {
    expect(detectArchiveKind("notes.txt")).toBeNull();
    expect(detectArchiveKind("noext")).toBeNull();
  });
});

describe("safeEntryPath", () => {
  it("joins a plain relative entry onto the destination", () => {
    expect(safeEntryPath("/out", "a/b.txt")).toBe("/out/a/b.txt");
  });

  it("rejects an empty entry name", () => {
    expect(safeEntryPath("/out", "")).toBeNull();
  });

  it("rejects a NUL byte", () => {
    expect(safeEntryPath("/out", "a\0b")).toBeNull();
  });

  it("rejects an absolute POSIX path", () => {
    expect(safeEntryPath("/out", "/etc/passwd")).toBeNull();
  });

  it("rejects a Windows drive path", () => {
    expect(safeEntryPath("/out", "C:/windows/system32")).toBeNull();
    expect(safeEntryPath("/out", "C:\\windows\\system32")).toBeNull();
  });

  it("rejects a backslash-rooted path", () => {
    expect(safeEntryPath("/out", "\\evil.txt")).toBeNull();
  });

  it("rejects an entry that escapes the destination with ..", () => {
    expect(safeEntryPath("/out", "../../evil.txt")).toBeNull();
    expect(safeEntryPath("/out", "..")).toBeNull();
  });

  it("resolves an intra-entry .. that never escapes", () => {
    expect(safeEntryPath("/out", "a/../b.txt")).toBe("/out/b.txt");
  });

  it("drops '.' segments", () => {
    expect(safeEntryPath("/out", "./a/./b.txt")).toBe("/out/a/b.txt");
  });

  it("treats backslashes in the entry name as separators", () => {
    expect(safeEntryPath("/out", "a\\b.txt")).toBe("/out/a/b.txt");
  });

  it("rejects an entry that normalizes to nothing", () => {
    expect(safeEntryPath("/out", ".")).toBeNull();
  });

  it("never escapes the destination (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom("..", ".", "a", "b", "evil"),
            fc.string({ minLength: 1, maxLength: 5 }).filter((s) => !s.includes("\0")),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        fc.constantFrom("/", "\\"),
        (segments, sep) => {
          const entryName = segments.join(sep);
          const result = safeEntryPath("/out", entryName);
          if (result !== null) {
            expect(isWithin("/out", result)).toBe(true);
            expect(normalizePath(result)).toBe(result);
          }
        },
      ),
    );
  });
});

it("skips overlong UTF-8 archive segments without aborting extraction", () => {
  expect(safeEntryPath("/out", `${"é".repeat(128)}/file`)).toBeNull();
  expect(safeEntryPath("/out", `${"é".repeat(127)}a`)).not.toBeNull();
});

describe("shared archive defaults", () => {
  it.each([
    [[], "archive"],
    [["/"], "archive"],
    [["/docs/report.pdf"], "report"],
    [["/docs/.env"], ".env"],
    [["/docs"], "docs"],
    [["/backup.tar.gz"], "backup"],
    [["/a/x", "/a/y"], "a"],
    [["/x", "/y"], "archive"],
  ])("names %j as %s", (paths, expected) => expect(defaultArchiveName(paths)).toBe(expected));

  it.each(["x.zip", "X.TGZ", "x.tar", "x.tar.gz", "x.tar.zst"])("can list %s", (name) => {
    expect(isPeekableArchiveName(name)).toBe(true);
  });
  it.each(["x.gz", "x.7z", "x.rar", "x.tar.xz", "x.tar.bz2", "x.txt"])("cannot list %s", (name) => {
    expect(isPeekableArchiveName(name)).toBe(false);
  });
});
