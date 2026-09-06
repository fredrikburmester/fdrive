import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys.ts";

describe("queryKeys", () => {
  it("auth.me() builds a stable key", () => {
    expect(queryKeys.auth.me()).toEqual(["auth", "me"]);
  });

  it("fs.list(path) builds a key scoped to the path", () => {
    expect(queryKeys.fs.list("/docs")).toEqual(["fs", "list", "/docs"]);
  });

  it("fs.stat(path) builds a key scoped to the path", () => {
    expect(queryKeys.fs.stat("/docs/file.txt")).toEqual(["fs", "stat", "/docs/file.txt"]);
  });

  it("account.tokens() builds a stable key", () => {
    expect(queryKeys.account.tokens()).toEqual(["account", "tokens"]);
  });

  it("tags.list() builds a stable key", () => {
    expect(queryKeys.tags.list()).toEqual(["tags", "list"]);
  });

  it("tags.files(id) builds a key scoped to the tag id", () => {
    expect(queryKeys.tags.files("tag-1")).toEqual(["tags", "files", "tag-1"]);
  });

  it("favorites.list() builds a stable key", () => {
    expect(queryKeys.favorites.list()).toEqual(["favorites", "list"]);
  });

  it("recents.list() builds a stable key", () => {
    expect(queryKeys.recents.list()).toEqual(["recents", "list"]);
  });
});
