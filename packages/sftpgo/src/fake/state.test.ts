import { describe, expect, it } from "vitest";
import { FakeState } from "./state.js";

describe("FakeState", () => {
  it("seeds users, folders, and files", () => {
    const state = new FakeState({
      users: [{ username: "alice", password: "secret", permissions: { "/": ["*"] } }],
      folders: [{ name: "shared" }],
      files: {
        alice: { "/a.txt": "hello" },
        "@shared": { "/note.txt": "shared note" },
      },
    });
    expect(state.users.get("alice")).toBeDefined();
    expect(state.folders.get("shared")).toBeDefined();
    expect(state.users.get("alice")?.volume.isFile("/a.txt")).toBe(true);
    expect(state.folders.get("shared")?.isFile("/note.txt")).toBe(true);
  });

  it("uses a custom clock and token ttl when provided", () => {
    const fixed = new Date("2024-01-01T00:00:00Z");
    const state = new FakeState({
      users: [{ username: "alice", password: "secret", permissions: {} }],
      tokenTtlMs: 1234,
      now: () => fixed,
    });
    expect(state.now()).toBe(fixed);
    expect(state.tokenTtlMs).toBe(1234);
  });

  it("defaults the token ttl to 20 minutes", () => {
    const state = new FakeState({ users: [] });
    expect(state.tokenTtlMs).toBe(20 * 60 * 1000);
  });

  it("resolveVolume falls back to a fresh empty volume for an unknown user", () => {
    const state = new FakeState({ users: [] });
    const { volume, innerPath } = state.resolveVolume("nobody", "/a/b");
    expect(innerPath).toBe("/a/b");
    expect(volume.has("/a/b")).toBe(false);
  });

  it("resolveVolume redirects into a virtual folder mount", () => {
    const state = new FakeState({
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: {},
          virtualFolders: [{ name: "shared", virtualPath: "/team" }],
        },
      ],
      folders: [{ name: "shared" }],
      files: { "@shared": { "/note.txt": "hi" } },
    });
    const { volume, innerPath } = state.resolveVolume("alice", "/team/note.txt");
    expect(innerPath).toBe("/note.txt");
    expect(volume).toBe(state.folders.get("shared"));
  });

  it("resolveVolume picks the longest matching mount when mounts overlap", () => {
    const state = new FakeState({
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: {},
          virtualFolders: [
            { name: "outer", virtualPath: "/a" },
            { name: "inner", virtualPath: "/a/b" },
          ],
        },
      ],
      folders: [{ name: "outer" }, { name: "inner" }],
    });
    const { volume, innerPath } = state.resolveVolume("alice", "/a/b/c.txt");
    expect(volume).toBe(state.folders.get("inner"));
    expect(innerPath).toBe("/c.txt");
  });

  it("resolveVolume falls back to the user's own volume outside any mount", () => {
    const state = new FakeState({
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: {},
          virtualFolders: [{ name: "shared", virtualPath: "/team" }],
        },
      ],
      folders: [{ name: "shared" }],
    });
    const { volume, innerPath } = state.resolveVolume("alice", "/private/x.txt");
    expect(volume).toBe(state.users.get("alice")?.volume);
    expect(innerPath).toBe("/private/x.txt");
  });

  it("generateId returns unique, prefixed ids", () => {
    const state = new FakeState({ users: [] });
    const first = state.generateId("share");
    const second = state.generateId("share");
    expect(first).not.toBe(second);
    expect(first.startsWith("share")).toBe(true);
  });

  it("generateToken returns unique opaque strings", () => {
    const state = new FakeState({ users: [] });
    const first = state.generateToken();
    const second = state.generateToken();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]+$/);
  });

  it("silently ignores a seed file for an undeclared shared folder", () => {
    const state = new FakeState({
      users: [],
      files: { "@undeclared": { "/a.txt": "hi" } },
    });
    expect(state.folders.size).toBe(0);
  });

  it("virtualFolderMountNamesAt returns the mount's last segment when its parent matches", () => {
    const state = new FakeState({
      users: [
        {
          username: "carol",
          password: "secret",
          permissions: {},
          virtualFolders: [{ name: "shared", virtualPath: "/shared" }],
        },
      ],
      folders: [{ name: "shared" }],
    });
    expect(state.virtualFolderMountNamesAt("carol", "/")).toEqual(["shared"]);
  });

  it("virtualFolderMountNamesAt returns nothing for a directory with no mount directly beneath it", () => {
    const state = new FakeState({
      users: [
        {
          username: "carol",
          password: "secret",
          permissions: {},
          virtualFolders: [{ name: "shared", virtualPath: "/nested/shared" }],
        },
      ],
      folders: [{ name: "shared" }],
    });
    expect(state.virtualFolderMountNamesAt("carol", "/")).toEqual([]);
    expect(state.virtualFolderMountNamesAt("carol", "/nested")).toEqual(["shared"]);
  });

  it("virtualFolderMountNamesAt returns nothing for an unknown user", () => {
    const state = new FakeState({ users: [] });
    expect(state.virtualFolderMountNamesAt("nobody", "/")).toEqual([]);
  });

  it("resolveVolume falls back to an empty volume when a virtual folder mount references an undeclared folder", () => {
    const state = new FakeState({
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: {},
          virtualFolders: [{ name: "ghost", virtualPath: "/g" }],
        },
      ],
    });
    const { volume, innerPath } = state.resolveVolume("alice", "/g/x.txt");
    expect(innerPath).toBe("/x.txt");
    expect(volume.has("/x.txt")).toBe(false);
  });
});
