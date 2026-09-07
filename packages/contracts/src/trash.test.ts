import { describe, expect, it } from "vitest";
import {
  isValidPath,
  TrashEntry,
  TrashListResponse,
  TrashPurgeRequest,
  TrashRestoreRequest,
  TrashRestoreResponse,
  TrashStatusResponse,
} from "./trash";

const AT = "2026-01-01T00:00:00.000Z";

describe("isValidPath", () => {
  it("accepts the root", () => {
    expect(isValidPath("/")).toBe(true);
  });

  it("accepts an absolute path with safe segments", () => {
    expect(isValidPath("/docs/a.txt")).toBe(true);
  });

  it("accepts segments with spaces and Unicode", () => {
    expect(isValidPath("/docs/sp ace Å.txt")).toBe(true);
  });

  it("rejects a relative path", () => {
    expect(isValidPath("docs/a.txt")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidPath("")).toBe(false);
  });

  it("rejects a path containing a '.' segment", () => {
    expect(isValidPath("/docs/./a.txt")).toBe(false);
  });

  it("rejects a path containing a '..' segment", () => {
    expect(isValidPath("/docs/../a.txt")).toBe(false);
  });

  it("rejects a path with an empty segment from a doubled slash", () => {
    expect(isValidPath("/docs//a.txt")).toBe(false);
  });

  it("rejects a path with a NUL byte in a segment", () => {
    expect(isValidPath("/docs/a\0.txt")).toBe(false);
  });
});

describe("TrashStatusResponse", () => {
  it("accepts an available trash with a path and retention", () => {
    expect(
      TrashStatusResponse.safeParse({ available: true, path: "/.trash", retentionHours: 720 })
        .success,
    ).toBe(true);
  });

  it("accepts an unavailable trash with null path and retention", () => {
    expect(
      TrashStatusResponse.safeParse({ available: false, path: null, retentionHours: null }).success,
    ).toBe(true);
  });

  it("rejects a non-positive retentionHours", () => {
    expect(
      TrashStatusResponse.safeParse({ available: true, path: "/.trash", retentionHours: 0 })
        .success,
    ).toBe(false);
  });
});

describe("TrashEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(
      TrashEntry.safeParse({
        id: "docs/a.txt/1788761221798866471",
        originalPath: "/docs/a.txt",
        name: "a.txt",
        size: 7,
        deletedAt: AT,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative size", () => {
    expect(
      TrashEntry.safeParse({
        id: "docs/a.txt/123",
        originalPath: "/docs/a.txt",
        name: "a.txt",
        size: -1,
        deletedAt: AT,
      }).success,
    ).toBe(false);
  });
});

describe("TrashListResponse", () => {
  it("accepts an empty, non-truncated listing", () => {
    expect(TrashListResponse.safeParse({ entries: [], truncated: false }).success).toBe(true);
  });
});

describe("TrashRestoreRequest", () => {
  it("accepts a single id with no target", () => {
    expect(TrashRestoreRequest.safeParse({ ids: ["a/1"] }).success).toBe(true);
  });

  it("accepts a single id with a valid target", () => {
    expect(TrashRestoreRequest.safeParse({ ids: ["a/1"], target: "/new/a.txt" }).success).toBe(
      true,
    );
  });

  it("accepts multiple ids with no target", () => {
    expect(TrashRestoreRequest.safeParse({ ids: ["a/1", "b/2"] }).success).toBe(true);
  });

  it("rejects multiple ids with a target", () => {
    expect(
      TrashRestoreRequest.safeParse({ ids: ["a/1", "b/2"], target: "/new/a.txt" }).success,
    ).toBe(false);
  });

  it("rejects an empty ids array", () => {
    expect(TrashRestoreRequest.safeParse({ ids: [] }).success).toBe(false);
  });

  it("rejects more than 1000 ids", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    expect(TrashRestoreRequest.safeParse({ ids }).success).toBe(false);
  });

  it("rejects an invalid target", () => {
    expect(TrashRestoreRequest.safeParse({ ids: ["a/1"], target: "relative" }).success).toBe(false);
  });
});

describe("TrashRestoreResponse", () => {
  it("accepts a list of restored FsEntry", () => {
    expect(
      TrashRestoreResponse.safeParse({
        restored: [
          {
            name: "a.txt",
            path: "/docs/a.txt",
            kind: "file",
            size: 7,
            modifiedAt: AT,
            ext: ".txt",
            mime: null,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("TrashPurgeRequest", () => {
  it("accepts a list of ids", () => {
    expect(TrashPurgeRequest.safeParse({ ids: ["a/1", "b/2"] }).success).toBe(true);
  });

  it("rejects an empty ids array", () => {
    expect(TrashPurgeRequest.safeParse({ ids: [] }).success).toBe(false);
  });
});
