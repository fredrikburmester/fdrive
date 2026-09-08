import { describe, expect, it } from "vitest";
import {
  CreateTagRequest,
  FavoriteItem,
  FavoriteKind,
  FavoriteRequest,
  FavoritesResponse,
  FolderViewMode,
  FolderViewResponse,
  FolderViewSort,
  FolderViewState,
  RecentItem,
  RecentsResponse,
  RecentTouchRequest,
  RemoveFolderViewRequest,
  SetFileTagsRequest,
  SetFolderViewRequest,
  Tag,
  TagFilesResponse,
  TagsResponse,
  UpdateTagRequest,
} from "./metadata";

describe("Tag", () => {
  it("accepts a tag with a color", () => {
    expect(Tag.safeParse({ id: "1", name: "Work", color: "#ff0000" }).success).toBe(true);
  });

  it("accepts a tag with a null color", () => {
    expect(Tag.safeParse({ id: "1", name: "Work", color: null }).success).toBe(true);
  });

  it("rejects a tag missing a name", () => {
    expect(Tag.safeParse({ id: "1", color: null }).success).toBe(false);
  });
});

describe("TagsResponse", () => {
  it("accepts an empty list", () => {
    expect(TagsResponse.safeParse({ tags: [] }).success).toBe(true);
  });
});

describe("CreateTagRequest", () => {
  it("accepts a name only", () => {
    expect(CreateTagRequest.safeParse({ name: "Work" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(CreateTagRequest.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects a name over 100 characters", () => {
    expect(CreateTagRequest.safeParse({ name: "a".repeat(101) }).success).toBe(false);
  });

  it("accepts an explicit null color", () => {
    expect(CreateTagRequest.safeParse({ name: "Work", color: null }).success).toBe(true);
  });
});

describe("UpdateTagRequest", () => {
  it("accepts an empty patch", () => {
    expect(UpdateTagRequest.safeParse({}).success).toBe(true);
  });

  it("accepts a color-only patch", () => {
    expect(UpdateTagRequest.safeParse({ color: "#00ff00" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(UpdateTagRequest.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("TagFilesResponse", () => {
  it("accepts a list of paths", () => {
    expect(TagFilesResponse.safeParse({ paths: ["/a.txt", "/b.txt"] }).success).toBe(true);
  });
});

describe("SetFileTagsRequest", () => {
  it("accepts a path with tag ids", () => {
    expect(SetFileTagsRequest.safeParse({ path: "/a.txt", tagIds: ["1", "2"] }).success).toBe(true);
  });

  it("accepts an empty tagIds array", () => {
    expect(SetFileTagsRequest.safeParse({ path: "/a.txt", tagIds: [] }).success).toBe(true);
  });

  it("rejects a missing path", () => {
    expect(SetFileTagsRequest.safeParse({ tagIds: [] }).success).toBe(false);
  });
});

describe("FavoriteKind", () => {
  it.each(["file", "dir"])("accepts %s", (kind) => {
    expect(FavoriteKind.safeParse(kind).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(FavoriteKind.safeParse("symlink").success).toBe(false);
  });
});

describe("FavoriteItem", () => {
  it("accepts a well-formed item", () => {
    const result = FavoriteItem.safeParse({
      path: "/a.txt",
      kind: "file",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-ISO addedAt", () => {
    expect(
      FavoriteItem.safeParse({ path: "/a.txt", kind: "file", addedAt: "not-a-date" }).success,
    ).toBe(false);
  });
});

describe("FavoritesResponse", () => {
  it("accepts an empty items list", () => {
    expect(FavoritesResponse.safeParse({ items: [] }).success).toBe(true);
  });
});

describe("FavoriteRequest", () => {
  it("accepts a path", () => {
    expect(FavoriteRequest.safeParse({ path: "/a.txt" }).success).toBe(true);
  });

  it("rejects a missing path", () => {
    expect(FavoriteRequest.safeParse({}).success).toBe(false);
  });
});

describe("folder views", () => {
  it("accepts a pin with the existing browser SortSpec shape", () => {
    expect(
      FolderViewState.safeParse({
        path: "/photos",
        mode: "grid",
        sort: { key: "modifiedAt", direction: "desc" },
      }).success,
    ).toBe(true);
    expect(FolderViewSort.safeParse({ key: "modified", direction: "desc" }).success).toBe(false);
  });

  it("accepts an absent pin and rejects invalid save/remove bodies", () => {
    expect(FolderViewResponse.parse({ view: null })).toEqual({ view: null });
    expect(FolderViewMode.safeParse("columns").success).toBe(false);
    expect(
      SetFolderViewRequest.safeParse({ path: "/photos", mode: "grid", sort: null }).success,
    ).toBe(false);
    expect(RemoveFolderViewRequest.safeParse({}).success).toBe(false);
  });
});

describe("RecentItem", () => {
  it("accepts a well-formed item", () => {
    expect(
      RecentItem.safeParse({ path: "/a.txt", openedAt: "2026-01-01T00:00:00.000Z" }).success,
    ).toBe(true);
  });
});

describe("RecentsResponse", () => {
  it("accepts an empty items list", () => {
    expect(RecentsResponse.safeParse({ items: [] }).success).toBe(true);
  });
});

describe("RecentTouchRequest", () => {
  it("accepts a path", () => {
    expect(RecentTouchRequest.safeParse({ path: "/a.txt" }).success).toBe(true);
  });

  it("rejects a missing path", () => {
    expect(RecentTouchRequest.safeParse({}).success).toBe(false);
  });
});
