import { describe, expect, it } from "vitest";
import { makeItemValue, parseItemValue } from "./item-value";

describe("makeItemValue and parseItemValue", () => {
  it("round-trips a folder value", () => {
    expect(parseItemValue(makeItemValue("folder", "/docs"))).toEqual({
      kind: "folder",
      path: "/docs",
    });
  });

  it("round-trips a file value", () => {
    expect(parseItemValue(makeItemValue("file", "/docs/report.pdf"))).toEqual({
      kind: "file",
      path: "/docs/report.pdf",
    });
  });

  it("round-trips a content value", () => {
    expect(parseItemValue(makeItemValue("content", "/notes.md"))).toEqual({
      kind: "content",
      path: "/notes.md",
    });
  });

  it("round-trips a recent value", () => {
    expect(parseItemValue(makeItemValue("recent", "/a.txt"))).toEqual({
      kind: "recent",
      path: "/a.txt",
    });
  });

  it("preserves a path containing a colon", () => {
    expect(parseItemValue(makeItemValue("file", "/weird:name.txt"))).toEqual({
      kind: "file",
      path: "/weird:name.txt",
    });
  });

  it("returns null for a value with no colon", () => {
    expect(parseItemValue("nocolon")).toBeNull();
  });

  it("returns null for an unknown kind prefix", () => {
    expect(parseItemValue("bogus:/a.txt")).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(parseItemValue("file:")).toBeNull();
  });

  it("returns null when the kind segment is empty", () => {
    expect(parseItemValue(":/a.txt")).toBeNull();
  });
});

it("roundtrips identity-qualified duplicate paths and rejects malformed account values", () => {
  const a = makeItemValue("file", "/same:[]", "one");
  const b = makeItemValue("file", "/same:[]", "two");
  expect(a).not.toBe(b);
  expect(parseItemValue(a)).toEqual({ kind: "file", path: "/same:[]", identityId: "one" });
  for (const value of [
    "account:oops",
    "account:{}",
    'account:["bad","/x","one"]',
    'account:["file","", "one"]',
    'account:["file","/x", ""]',
    'account:["file","/x", 1]',
  ])
    expect(parseItemValue(value)).toBeNull();
});
