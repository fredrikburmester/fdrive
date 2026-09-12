import { describe, expect, it } from "vitest";
import { FakeVolume } from "./volume.js";

function volume(): FakeVolume {
  let tick = 0;
  return new FakeVolume(() => new Date(1_700_000_000_000 + tick++ * 1000));
}

describe("FakeVolume", () => {
  it("starts with a root and creates nested directories on demand", () => {
    const v = volume();
    expect(v.isDir("/")).toBe(true);
    v.mkdirAll("/a/b/c");
    expect(v.paths()).toEqual(["/", "/a", "/a/b", "/a/b/c"]);
    v.mkdirAll("/a/b");
    expect(v.paths()).toHaveLength(4);
    expect(v.children("/a")).toEqual(["/a/b"]);
    expect(v.children("/")).toEqual(["/a"]);
  });

  it("stores files with type and mtime", () => {
    const v = volume();
    v.putFile("/f", new Uint8Array([1]), { contentType: "text/plain" });
    expect(v.get("/f")).toMatchObject({ kind: "file", contentType: "text/plain" });
    const at = new Date("2020-01-01T00:00:00Z");
    v.putFile("/g", new Uint8Array([2]), { modifiedAt: at });
    expect(v.get("/g")).toMatchObject({ contentType: null, modifiedAt: at });
    expect(v.has("/g")).toBe(true);
    expect(v.isDir("/g")).toBe(false);
  });

  it("removes subtrees", () => {
    const v = volume();
    v.mkdirAll("/a/b");
    v.putFile("/a/b/f", new Uint8Array());
    v.putFile("/ab", new Uint8Array());
    v.remove("/a");
    expect(v.paths()).toEqual(["/", "/ab"]);
  });

  it("copies files, deep trees and shallow collections", () => {
    const v = volume();
    v.mkdirAll("/src/inner");
    v.putFile("/src/f", new Uint8Array([7]), { contentType: "x/y" });
    v.putFile("/src/inner/g", new Uint8Array([8]));
    v.copy("/src", "/deep");
    expect(v.paths()).toContain("/deep/inner/g");
    expect(v.get("/deep/f")).toMatchObject({ contentType: "x/y" });
    v.copy("/src", "/shallow", { shallow: true });
    expect(v.children("/shallow")).toEqual([]);
    v.copy("/src/f", "/copy");
    expect(v.get("/copy")).toMatchObject({ kind: "file" });
    v.copy("/missing", "/nowhere");
    expect(v.has("/nowhere")).toBe(false);
  });

  it("moves by copying then removing the source", () => {
    const v = volume();
    v.mkdirAll("/a");
    v.putFile("/a/f", new Uint8Array([1]));
    v.move("/a", "/b");
    expect(v.paths()).toEqual(["/", "/b", "/b/f"]);
  });
});
