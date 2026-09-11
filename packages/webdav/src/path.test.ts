import { describe, expect, it } from "vitest";
import {
  assertValidPath,
  baseNameOf,
  encodePath,
  endpointPrefix,
  isWithin,
  parentOf,
  resolveHref,
  segmentsOf,
} from "./path.js";

describe("assertValidPath", () => {
  it("accepts absolute paths and rejects relative or NUL paths", () => {
    expect(() => assertValidPath("/a/b")).not.toThrow();
    expect(() => assertValidPath("a/b")).toThrow(/Invalid WebDAV path/);
    expect(() => assertValidPath("/a\0b")).toThrow(/Invalid WebDAV path/);
    expect(() => assertValidPath("/a/../b")).toThrow(/Invalid WebDAV path/);
    expect(() => assertValidPath("/./x")).toThrow(/Invalid WebDAV path/);
    expect(() => assertValidPath("/a..b/.env")).not.toThrow();
  });
});

describe("encodePath", () => {
  it("encodes each segment, keeping literal percents and Unicode reversible", () => {
    expect(encodePath("/")).toBe("");
    expect(encodePath("/a b/%41/ü😀.txt")).toBe("a%20b/%2541/%C3%BC%F0%9F%98%80.txt");
    expect(encodePath("/a#b?c/d")).toBe("a%23b%3Fc/d");
  });
});

describe("segment helpers", () => {
  it("splits, finds parents, base names and containment", () => {
    expect(segmentsOf("/a//b/")).toEqual(["a", "b"]);
    expect(parentOf("/a/b/c")).toBe("/a/b");
    expect(parentOf("/a")).toBe("/");
    expect(parentOf("/")).toBe("/");
    expect(baseNameOf("/a/b.txt")).toBe("b.txt");
    expect(baseNameOf("/")).toBe("");
    expect(isWithin("/", "/x")).toBe(true);
    expect(isWithin("/a", "/a")).toBe(true);
    expect(isWithin("/a", "/a/b")).toBe(true);
    expect(isWithin("/a", "/ab")).toBe(false);
  });
});

describe("endpointPrefix", () => {
  it("always ends with a slash", () => {
    expect(endpointPrefix("http://host")).toBe("/");
    expect(endpointPrefix("http://host/dav")).toBe("/dav/");
    expect(endpointPrefix("http://host/dav/")).toBe("/dav/");
  });
});

describe("resolveHref", () => {
  const base = "http://host:8080/dav/";

  it("resolves path and absolute hrefs under the prefix", () => {
    expect(resolveHref("/dav/a%20b/c.txt", base)).toBe("/a b/c.txt");
    expect(resolveHref("http://host:8080/dav/a/", base)).toBe("/a");
    expect(resolveHref("/dav/", base)).toBe("/");
    expect(resolveHref("/dav", base)).toBe("/");
    expect(resolveHref("/dav/%2541.txt", base)).toBe("/%41.txt");
    expect(resolveHref("/dav/%C3%BC%F0%9F%98%80", base)).toBe("/ü😀");
  });

  it("works for an endpoint at the origin root", () => {
    expect(resolveHref("/", "http://host")).toBe("/");
    expect(resolveHref("/x/y", "http://host")).toBe("/x/y");
  });

  it("ignores foreign origins, paths outside the prefix and traversal", () => {
    expect(resolveHref("http://other/dav/a", base)).toBeNull();
    expect(resolveHref("https://host:8080/dav/a", base)).toBeNull();
    expect(resolveHref("/other/a", base)).toBeNull();
    expect(resolveHref("/davx/a", base)).toBeNull();
    expect(resolveHref("/dav/%2e%2e/a", base)).toBeNull();
    expect(resolveHref("/dav/../a", base)).toBeNull();
  });

  it("lets the URL parser resolve dot segments inside the prefix", () => {
    expect(resolveHref("/dav/%2E", base)).toBe("/");
    expect(resolveHref("/dav/a/%2e%2e/b", base)).toBe("/b");
  });

  it("keeps a raw segment whose percent encoding is malformed", () => {
    expect(resolveHref("/dav/bad%ZZ", base)).toBe("/bad%ZZ");
  });

  it("returns null for an unparsable reference", () => {
    expect(resolveHref("http://[bad", base)).toBeNull();
  });
});
