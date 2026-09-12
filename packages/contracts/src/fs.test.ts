import { describe, expect, it } from "vitest";
import {
  ArchiveEntriesFormat,
  ArchiveEntriesResponse,
  ArchiveEntry,
  CompressRequest,
  CopyRequest,
  DeleteRequest,
  DownloadQuery,
  DuplicateRequest,
  EntryKind,
  EntryResponse,
  ExtractRequest,
  FolderSizeResponse,
  FsEntry,
  isValidEntryName,
  ListResponse,
  MkdirRequest,
  MoveRequest,
  OkResponse,
  PathQuery,
  RenameRequest,
  UploadQuery,
  ZipRequest,
} from "./fs";

const VALID_ENTRY = {
  name: "photo.jpg",
  path: "/photos/photo.jpg",
  kind: "file",
  size: 1024,
  modifiedAt: "2026-01-01T00:00:00.000Z",
  ext: "jpg",
  mime: "image/jpeg",
};

describe("EntryKind", () => {
  it.each(["file", "dir", "symlink", "other"])("accepts %s", (kind) => {
    expect(EntryKind.safeParse(kind).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(EntryKind.safeParse("block-device").success).toBe(false);
  });
});

describe("FsEntry", () => {
  it("parses a valid entry", () => {
    expect(FsEntry.parse(VALID_ENTRY)).toEqual(VALID_ENTRY);
  });

  it("accepts a null mime", () => {
    expect(FsEntry.safeParse({ ...VALID_ENTRY, mime: null }).success).toBe(true);
  });

  it("rejects a negative size", () => {
    expect(FsEntry.safeParse({ ...VALID_ENTRY, size: -1 }).success).toBe(false);
  });

  it("rejects a non-integer size", () => {
    expect(FsEntry.safeParse({ ...VALID_ENTRY, size: 1.5 }).success).toBe(false);
  });

  it("rejects a non-ISO modifiedAt", () => {
    expect(FsEntry.safeParse({ ...VALID_ENTRY, modifiedAt: "not-a-date" }).success).toBe(false);
  });
});

describe("ListResponse", () => {
  it("parses a valid payload", () => {
    const payload = { path: "/photos", entries: [VALID_ENTRY] };
    expect(ListResponse.parse(payload)).toEqual(payload);
  });

  it("accepts an empty entries array", () => {
    expect(ListResponse.safeParse({ path: "/photos", entries: [] }).success).toBe(true);
  });

  it("rejects an invalid entry in the array", () => {
    const payload = { path: "/photos", entries: [{ ...VALID_ENTRY, size: -1 }] };
    expect(ListResponse.safeParse(payload).success).toBe(false);
  });
});

describe("PathQuery", () => {
  it("parses a path", () => {
    expect(PathQuery.parse({ path: "/a" })).toEqual({ path: "/a" });
  });

  it("rejects a missing path", () => {
    expect(PathQuery.safeParse({}).success).toBe(false);
  });
});

describe("FolderSizeResponse", () => {
  it("parses an indexed folder size", () => {
    expect(
      FolderSizeResponse.safeParse({ path: "/photos", bytes: 1024, files: 3, indexed: true })
        .success,
    ).toBe(true);
  });

  it("parses a not-indexed folder", () => {
    expect(
      FolderSizeResponse.safeParse({ path: "/photos", bytes: 0, files: 0, indexed: false }).success,
    ).toBe(true);
  });

  it("rejects a negative byte count", () => {
    expect(
      FolderSizeResponse.safeParse({ path: "/photos", bytes: -1, files: 0, indexed: false })
        .success,
    ).toBe(false);
  });

  it("rejects a missing indexed flag", () => {
    expect(FolderSizeResponse.safeParse({ path: "/photos", bytes: 0, files: 0 }).success).toBe(
      false,
    );
  });
});

describe("DownloadQuery", () => {
  it("parses a path without inline", () => {
    expect(DownloadQuery.safeParse({ path: "/a" }).success).toBe(true);
  });

  it("parses a path with inline=1", () => {
    expect(DownloadQuery.safeParse({ path: "/a", inline: "1" }).success).toBe(true);
  });

  it("rejects an invalid inline value", () => {
    expect(DownloadQuery.safeParse({ path: "/a", inline: "yes" }).success).toBe(false);
  });
});

describe("UploadQuery", () => {
  it("parses a path without mkdirParents", () => {
    expect(UploadQuery.safeParse({ path: "/a/b.txt" }).success).toBe(true);
  });

  it.each(["true", "false"])("accepts mkdirParents=%s", (value) => {
    expect(UploadQuery.safeParse({ path: "/a/b.txt", mkdirParents: value }).success).toBe(true);
  });

  it("rejects an invalid mkdirParents value", () => {
    expect(UploadQuery.safeParse({ path: "/a/b.txt", mkdirParents: "1" }).success).toBe(false);
  });
});

describe("MkdirRequest", () => {
  it("parses a path", () => {
    expect(MkdirRequest.safeParse({ path: "/a" }).success).toBe(true);
  });

  it("rejects a missing path", () => {
    expect(MkdirRequest.safeParse({}).success).toBe(false);
  });
});

describe("MoveRequest", () => {
  it("parses path and target", () => {
    expect(MoveRequest.safeParse({ path: "/a", target: "/b" }).success).toBe(true);
  });

  it("rejects a missing target", () => {
    expect(MoveRequest.safeParse({ path: "/a" }).success).toBe(false);
  });
});

describe("CopyRequest", () => {
  it("parses path and target", () => {
    expect(CopyRequest.safeParse({ path: "/a", target: "/b" }).success).toBe(true);
  });

  it("rejects a missing path", () => {
    expect(CopyRequest.safeParse({ target: "/b" }).success).toBe(false);
  });
});

describe("isValidEntryName", () => {
  it("accepts an ordinary name", () => {
    expect(isValidEntryName("report.pdf")).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(isValidEntryName("")).toBe(false);
  });

  it("rejects a name over 255 characters", () => {
    expect(isValidEntryName("a".repeat(256))).toBe(false);
  });

  it("rejects a name containing a slash", () => {
    expect(isValidEntryName("a/b")).toBe(false);
  });

  it("rejects a name containing a NUL byte", () => {
    expect(isValidEntryName("a\0b")).toBe(false);
  });

  it('rejects "."', () => {
    expect(isValidEntryName(".")).toBe(false);
  });

  it('rejects ".."', () => {
    expect(isValidEntryName("..")).toBe(false);
  });
});

describe("RenameRequest", () => {
  it("parses a valid rename", () => {
    expect(RenameRequest.safeParse({ path: "/a/old.txt", newName: "new.txt" }).success).toBe(true);
  });

  it("rejects a newName containing a slash", () => {
    expect(RenameRequest.safeParse({ path: "/a/old.txt", newName: "a/b" }).success).toBe(false);
  });

  it('rejects a newName of ".."', () => {
    expect(RenameRequest.safeParse({ path: "/a/old.txt", newName: ".." }).success).toBe(false);
  });

  it("rejects an empty newName", () => {
    expect(RenameRequest.safeParse({ path: "/a/old.txt", newName: "" }).success).toBe(false);
  });
});

describe("DeleteRequest", () => {
  it("parses a single item", () => {
    const payload = { items: [{ path: "/a", kind: "file" }] };
    expect(DeleteRequest.parse(payload)).toEqual(payload);
  });

  it("rejects an empty items array", () => {
    expect(DeleteRequest.safeParse({ items: [] }).success).toBe(false);
  });

  it("rejects more than 1000 items", () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({ path: `/${i}`, kind: "file" }));
    expect(DeleteRequest.safeParse({ items }).success).toBe(false);
  });

  it("accepts exactly 1000 items", () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ path: `/${i}`, kind: "file" }));
    expect(DeleteRequest.safeParse({ items }).success).toBe(true);
  });

  it("rejects an item with an invalid kind", () => {
    expect(DeleteRequest.safeParse({ items: [{ path: "/a", kind: "symlink" }] }).success).toBe(
      false,
    );
  });
});

describe("ZipRequest", () => {
  it("parses paths without a name", () => {
    expect(ZipRequest.safeParse({ paths: ["/a", "/b"] }).success).toBe(true);
  });

  it("parses paths with a name", () => {
    expect(ZipRequest.safeParse({ paths: ["/a"], name: "archive.zip" }).success).toBe(true);
  });

  it("rejects an empty paths array", () => {
    expect(ZipRequest.safeParse({ paths: [] }).success).toBe(false);
  });

  it("rejects more than 1000 paths", () => {
    const paths = Array.from({ length: 1001 }, (_, i) => `/${i}`);
    expect(ZipRequest.safeParse({ paths }).success).toBe(false);
  });
});

describe("EntryResponse", () => {
  it("is the same shape as FsEntry", () => {
    expect(EntryResponse.parse(VALID_ENTRY)).toEqual(VALID_ENTRY);
  });
});

describe("OkResponse", () => {
  it("parses { ok: true }", () => {
    expect(OkResponse.safeParse({ ok: true }).success).toBe(true);
  });

  it("rejects { ok: false }", () => {
    expect(OkResponse.safeParse({ ok: false }).success).toBe(false);
  });
});

describe("DuplicateRequest", () => {
  it("parses a path", () => {
    expect(DuplicateRequest.safeParse({ path: "/a.txt" }).success).toBe(true);
  });

  it("rejects a missing path", () => {
    expect(DuplicateRequest.safeParse({}).success).toBe(false);
  });
});

describe("CompressRequest", () => {
  it("parses the minimal form", () => {
    expect(CompressRequest.safeParse({ paths: ["/a"], format: "zip" }).success).toBe(true);
  });

  it("parses with name and destination", () => {
    const payload = { paths: ["/a", "/b"], format: "tar.gz", name: "bundle", destination: "/out" };
    expect(CompressRequest.parse(payload)).toEqual(payload);
  });

  it.each(["zip", "tar.gz", "tar.zst"])("accepts format %s", (format) => {
    expect(CompressRequest.safeParse({ paths: ["/a"], format }).success).toBe(true);
  });

  it("rejects an unknown format", () => {
    expect(CompressRequest.safeParse({ paths: ["/a"], format: "rar" }).success).toBe(false);
  });

  it("rejects an empty paths array", () => {
    expect(CompressRequest.safeParse({ paths: [], format: "zip" }).success).toBe(false);
  });

  it("rejects more than 1000 paths", () => {
    const paths = Array.from({ length: 1001 }, (_, i) => `/${i}`);
    expect(CompressRequest.safeParse({ paths, format: "zip" }).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(CompressRequest.safeParse({ paths: ["/a"], format: "zip", name: "" }).success).toBe(
      false,
    );
  });
});

describe("ExtractRequest", () => {
  it("parses a path without a destination", () => {
    expect(ExtractRequest.safeParse({ path: "/a.zip" }).success).toBe(true);
  });

  it("parses a path with a destination", () => {
    const payload = { path: "/a.zip", destination: "/out" };
    expect(ExtractRequest.parse(payload)).toEqual(payload);
  });

  it("rejects a missing path", () => {
    expect(ExtractRequest.safeParse({}).success).toBe(false);
  });
});

describe("ArchiveEntriesFormat", () => {
  it.each(["zip", "tar", "tar.gz", "tar.zst"])("accepts %s", (format) => {
    expect(ArchiveEntriesFormat.safeParse(format).success).toBe(true);
  });

  it("rejects a bare gz (no listable entries of its own)", () => {
    expect(ArchiveEntriesFormat.safeParse("gz").success).toBe(false);
  });

  it("rejects an unknown format", () => {
    expect(ArchiveEntriesFormat.safeParse("rar").success).toBe(false);
  });
});

describe("ArchiveEntry", () => {
  const VALID_FILE_ENTRY = {
    path: "dir/file.txt",
    kind: "file",
    size: 42,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };

  it("parses a valid file entry", () => {
    expect(ArchiveEntry.parse(VALID_FILE_ENTRY)).toEqual(VALID_FILE_ENTRY);
  });

  it("parses a directory entry", () => {
    expect(ArchiveEntry.safeParse({ ...VALID_FILE_ENTRY, kind: "dir" }).success).toBe(true);
  });

  it("accepts a null modifiedAt", () => {
    expect(ArchiveEntry.safeParse({ ...VALID_FILE_ENTRY, modifiedAt: null }).success).toBe(true);
  });

  it("rejects a negative size", () => {
    expect(ArchiveEntry.safeParse({ ...VALID_FILE_ENTRY, size: -1 }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(ArchiveEntry.safeParse({ ...VALID_FILE_ENTRY, kind: "symlink" }).success).toBe(false);
  });
});

describe("ArchiveEntriesResponse", () => {
  const VALID_ENTRY = {
    path: "dir/file.txt",
    kind: "file",
    size: 42,
    modifiedAt: null,
  };

  it("parses a valid payload", () => {
    const payload = { format: "zip", entries: [VALID_ENTRY], truncated: false };
    expect(ArchiveEntriesResponse.parse(payload)).toEqual(payload);
  });

  it("accepts an empty entries array", () => {
    expect(
      ArchiveEntriesResponse.safeParse({ format: "tar", entries: [], truncated: false }).success,
    ).toBe(true);
  });

  it("rejects an invalid entry in the array", () => {
    const payload = {
      format: "zip",
      entries: [{ ...VALID_ENTRY, size: -1 }],
      truncated: false,
    };
    expect(ArchiveEntriesResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing truncated flag", () => {
    expect(ArchiveEntriesResponse.safeParse({ format: "zip", entries: [] }).success).toBe(false);
  });
});

it("validates names by UTF-8 bytes", () => {
  const accepted = `${"é".repeat(127)}a`;
  const rejected = "é".repeat(128);
  expect(isValidEntryName(accepted)).toBe(true);
  expect(RenameRequest.safeParse({ path: "/old", newName: accepted }).success).toBe(true);
  expect(isValidEntryName(rejected)).toBe(false);
  expect(RenameRequest.safeParse({ path: "/old", newName: rejected }).success).toBe(false);
});
