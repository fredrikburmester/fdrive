import { describe, expect, it } from "vitest";
import { childName, copySource, dirKey, fileKey } from "./keys.js";

describe("fileKey and dirKey", () => {
  it("maps paths under an empty prefix", () => {
    expect(fileKey("", "/a/b.txt")).toBe("a/b.txt");
    expect(fileKey("", "a/b.txt")).toBe("a/b.txt");
    expect(dirKey("", "/")).toBe("");
    expect(dirKey("", "/a/b")).toBe("a/b/");
  });

  it("maps paths under a prefix", () => {
    expect(fileKey("p/q", "/a.txt")).toBe("p/q/a.txt");
    expect(dirKey("p/q", "/")).toBe("p/q/");
    expect(dirKey("p/q", "/a")).toBe("p/q/a/");
  });

  it("refuses the root as a file", () => {
    expect(() => fileKey("", "/")).toThrow("the root is not a file");
  });
});

describe("childName", () => {
  it("names direct children and ignores everything else", () => {
    expect(childName("a/", "a/b.txt")).toBe("b.txt");
    expect(childName("a/", "a/c/")).toBe("c");
    expect(childName("a/", "a/")).toBeNull();
    expect(childName("a/", "a/c/d.txt")).toBeNull();
    expect(childName("a/", "b/x.txt")).toBeNull();
    expect(childName("a/", "a/..")).toBeNull();
    expect(childName("", "top.txt")).toBe("top.txt");
  });
});

describe("copySource", () => {
  it("percent-encodes each key segment under the bucket", () => {
    expect(copySource("bucket", "a b/%41/ü.txt")).toBe("bucket/a%20b/%2541/%C3%BC.txt");
  });
});
