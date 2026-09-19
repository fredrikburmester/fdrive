import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys.ts";

describe("queryKeys", () => {
  it("folder view keys isolate identities and paths with a shared reset prefix", () => {
    expect(queryKeys.folderViews.all()).toEqual(["folder-views"]);
    expect(queryKeys.folderViews.path("alice", "/photos")).toEqual([
      "folder-views",
      "alice",
      "/photos",
    ]);
  });
  it("AI keys separate status, one run per id, and the admin settings", () => {
    expect(queryKeys.ai.status()).toEqual(["ai", "status"]);
    expect(queryKeys.ai.run("run-1")).toEqual(["ai", "organize", "run-1"]);
    expect(queryKeys.ai.chats()).toEqual(["ai", "chats"]);
    expect(queryKeys.ai.chat("c1")).toEqual(["ai", "chat", "c1"]);
    expect(queryKeys.system.ai()).toEqual(["system", "ai"]);
  });
  it("auth.me() builds a stable key", () => {
    expect(queryKeys.auth.me()).toEqual(["auth", "me"]);
  });

  it("fs.list(path) builds a key scoped to the path", () => {
    expect(queryKeys.fs.list("/docs")).toEqual(["fs", "list", "/docs"]);
  });

  it("fs.stat(path) builds a key scoped to the path", () => {
    expect(queryKeys.fs.stat("/docs/file.txt")).toEqual(["fs", "stat", "/docs/file.txt"]);
  });

  it("fs.folderSize(path) builds a key scoped to the path", () => {
    expect(queryKeys.fs.folderSize("/photos")).toEqual(["fs", "folder-size", "/photos"]);
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

  it("trash.status() builds a stable key", () => {
    expect(queryKeys.trash.status()).toEqual(["trash", "status"]);
  });

  it("trash.list() builds a stable key", () => {
    expect(queryKeys.trash.list()).toEqual(["trash", "list"]);
  });
});
