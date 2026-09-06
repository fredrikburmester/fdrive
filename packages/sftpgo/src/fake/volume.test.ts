import { describe, expect, it } from "vitest";
import { Volume } from "./volume.js";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("Volume", () => {
  it("starts with only the root directory", () => {
    const volume = new Volume();
    expect(volume.isDir("/")).toBe(true);
    expect(volume.has("/a")).toBe(false);
  });

  describe("mkdir", () => {
    it("creates a directory under the root", () => {
      const volume = new Volume();
      expect(volume.mkdir("/a", false)).toBe("ok");
      expect(volume.isDir("/a")).toBe(true);
    });

    it("returns conflict when the path already exists", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      expect(volume.mkdir("/a", false)).toBe("conflict");
    });

    it("returns not_found when the parent is missing and parents is false", () => {
      const volume = new Volume();
      expect(volume.mkdir("/a/b", false)).toBe("not_found");
    });

    it("creates missing ancestors when parents is true", () => {
      const volume = new Volume();
      expect(volume.mkdir("/a/b/c", true)).toBe("ok");
      expect(volume.isDir("/a")).toBe(true);
      expect(volume.isDir("/a/b")).toBe(true);
      expect(volume.isDir("/a/b/c")).toBe(true);
    });

    it("reuses an already-existing ancestor directory instead of recreating it", () => {
      const volume = new Volume();
      expect(volume.mkdir("/a/b", true)).toBe("ok");
      expect(volume.mkdir("/a/c", true)).toBe("ok");
      expect(volume.isDir("/a")).toBe(true);
      expect(volume.isDir("/a/c")).toBe(true);
    });
  });

  describe("writeFile", () => {
    it("writes a file under an existing directory", () => {
      const volume = new Volume();
      expect(volume.writeFile("/a.txt", bytes("hi"), 1000, false)).toBe("ok");
      expect(volume.isFile("/a.txt")).toBe(true);
    });

    it("returns not_found when the parent is missing and mkdirParents is false", () => {
      const volume = new Volume();
      expect(volume.writeFile("/a/b.txt", bytes("hi"), 1000, false)).toBe("not_found");
    });

    it("creates missing ancestors when mkdirParents is true", () => {
      const volume = new Volume();
      expect(volume.writeFile("/a/b.txt", bytes("hi"), 1000, true)).toBe("ok");
      expect(volume.isDir("/a")).toBe(true);
    });

    it("returns bad_request when the target is an existing directory", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      expect(volume.writeFile("/a", bytes("hi"), 1000, false)).toBe("bad_request");
    });

    it("returns bad_request when the parent is a file, not a directory", () => {
      const volume = new Volume();
      volume.writeFile("/a", bytes("hi"), 1000, false);
      expect(volume.writeFile("/a/b.txt", bytes("hi"), 1000, false)).toBe("bad_request");
    });

    it("overwrites an existing file", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("first"), 1000, false);
      volume.writeFile("/a.txt", bytes("second"), 2000, false);
      const node = volume.get("/a.txt");
      expect(node?.kind).toBe("file");
      expect(node?.kind === "file" ? new TextDecoder().decode(node.content) : null).toBe("second");
    });
  });

  describe("listChildren", () => {
    it("returns null for a path that does not exist", () => {
      const volume = new Volume();
      expect(volume.listChildren("/missing")).toBeNull();
    });

    it("returns null for a path that is a file", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      expect(volume.listChildren("/a.txt")).toBeNull();
    });

    it("lists direct children only", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      volume.writeFile("/a/b.txt", bytes("hi"), 1000, false);
      volume.mkdir("/a/c", false);
      volume.writeFile("/a/c/d.txt", bytes("hi"), 1000, false);
      const names = volume
        .listChildren("/a")
        ?.map((entry) => entry.name)
        .sort();
      expect(names).toEqual(["b.txt", "c"]);
    });

    it("lists top-level entries under the root", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      const names = volume.listChildren("/")?.map((entry) => entry.name);
      expect(names).toEqual(["a.txt"]);
    });
  });

  describe("deleteFile", () => {
    it("deletes an existing file", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      expect(volume.deleteFile("/a.txt")).toBe("ok");
      expect(volume.has("/a.txt")).toBe(false);
    });

    it("returns not_found for a missing path", () => {
      const volume = new Volume();
      expect(volume.deleteFile("/missing")).toBe("not_found");
    });

    it("returns bad_request for a directory", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      expect(volume.deleteFile("/a")).toBe("bad_request");
    });
  });

  describe("deleteDir", () => {
    it("deletes a directory and everything under it", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      volume.writeFile("/a/b.txt", bytes("hi"), 1000, false);
      volume.mkdir("/a/c", false);
      expect(volume.deleteDir("/a")).toBe("ok");
      expect(volume.has("/a")).toBe(false);
      expect(volume.has("/a/b.txt")).toBe(false);
      expect(volume.has("/a/c")).toBe(false);
    });

    it("returns not_found for a missing path", () => {
      const volume = new Volume();
      expect(volume.deleteDir("/missing")).toBe("not_found");
    });

    it("returns bad_request for a file", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      expect(volume.deleteDir("/a.txt")).toBe("bad_request");
    });

    it("does not delete a sibling that shares a name prefix", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      volume.mkdir("/ab", false);
      volume.deleteDir("/a");
      expect(volume.has("/ab")).toBe(true);
    });

    it("can delete the root, clearing everything but keeping it present", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      volume.writeFile("/b.txt", bytes("hi"), 1000, false);
      expect(volume.deleteDir("/")).toBe("ok");
      expect(volume.isDir("/")).toBe(true);
      expect(volume.has("/a")).toBe(false);
      expect(volume.has("/b.txt")).toBe(false);
    });
  });

  describe("setMtime", () => {
    it("updates the mtime of an existing file", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      expect(volume.setMtime("/a.txt", 9999)).toBe("ok");
      const node = volume.get("/a.txt");
      expect(node?.kind === "file" ? node.mtimeMs : null).toBe(9999);
    });

    it("returns not_found for a missing path", () => {
      const volume = new Volume();
      expect(volume.setMtime("/missing", 1)).toBe("not_found");
    });

    it("returns bad_request for a directory", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      expect(volume.setMtime("/a", 1)).toBe("bad_request");
    });
  });

  describe("move", () => {
    it("moves a file to a new path", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      expect(volume.move("/a.txt", "/b.txt")).toBe("ok");
      expect(volume.has("/a.txt")).toBe(false);
      expect(volume.isFile("/b.txt")).toBe(true);
    });

    it("moves a directory, its files, and its nested subdirectories", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      volume.writeFile("/a/x.txt", bytes("hi"), 1000, false);
      volume.mkdir("/a/sub", false);
      volume.writeFile("/a/sub/y.txt", bytes("nested"), 1000, false);
      expect(volume.move("/a", "/b")).toBe("ok");
      expect(volume.has("/a")).toBe(false);
      expect(volume.isDir("/b")).toBe(true);
      expect(volume.isFile("/b/x.txt")).toBe(true);
      expect(volume.isDir("/b/sub")).toBe(true);
      expect(volume.isFile("/b/sub/y.txt")).toBe(true);
    });

    it("returns not_found when the source is missing", () => {
      const volume = new Volume();
      expect(volume.move("/missing", "/dest")).toBe("not_found");
    });

    it("returns conflict when the target already exists", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      volume.writeFile("/b.txt", bytes("hi"), 1000, false);
      expect(volume.move("/a.txt", "/b.txt")).toBe("conflict");
    });

    it("creates missing ancestor directories for the target", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      expect(volume.move("/a.txt", "/new/nested/b.txt")).toBe("ok");
      expect(volume.isFile("/new/nested/b.txt")).toBe(true);
    });
  });

  describe("copy", () => {
    it("copies a file, keeping the source", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      expect(volume.copy("/a.txt", "/b.txt")).toBe("ok");
      expect(volume.isFile("/a.txt")).toBe(true);
      expect(volume.isFile("/b.txt")).toBe(true);
    });

    it("copies a directory and its contents", () => {
      const volume = new Volume();
      volume.mkdir("/a", false);
      volume.writeFile("/a/x.txt", bytes("hi"), 1000, false);
      expect(volume.copy("/a", "/b")).toBe("ok");
      expect(volume.isDir("/a")).toBe(true);
      expect(volume.isFile("/a/x.txt")).toBe(true);
      expect(volume.isDir("/b")).toBe(true);
      expect(volume.isFile("/b/x.txt")).toBe(true);
    });

    it("returns not_found when the source is missing", () => {
      const volume = new Volume();
      expect(volume.copy("/missing", "/dest")).toBe("not_found");
    });

    it("returns conflict when the target already exists", () => {
      const volume = new Volume();
      volume.writeFile("/a.txt", bytes("hi"), 1000, false);
      volume.writeFile("/b.txt", bytes("hi"), 1000, false);
      expect(volume.copy("/a.txt", "/b.txt")).toBe("conflict");
    });
  });
});
