import { describe, expect, it } from "vitest";
import { dateFromMtimeNs, toIndexRelativePath, trashExclusion } from "./scopes";

describe("dateFromMtimeNs", () => {
  it("converts nanoseconds since epoch to a Date at millisecond precision", () => {
    const ns = 1_700_000_000_000_000_000n;
    expect(dateFromMtimeNs(ns)).toEqual(new Date(1_700_000_000_000));
  });

  it("converts zero to the epoch", () => {
    expect(dateFromMtimeNs(0n)).toEqual(new Date(0));
  });
});

describe("toIndexRelativePath", () => {
  it("maps the root prefix to an empty string", () => {
    expect(toIndexRelativePath("/")).toBe("");
  });

  it("strips the leading slash from a subtree path", () => {
    expect(toIndexRelativePath("/alice/photos")).toBe("alice/photos");
  });
});

describe("trashExclusion", () => {
  const home = { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" };
  const mount = {
    rootName: "files",
    fsPrefix: "/bob/Projects",
    virtualPrefix: "/Shared with me/Projects",
  };

  it("maps the Trash through the home onto its root", () => {
    expect(trashExclusion([home, mount], "/.trash", { files: 3 })).toEqual([
      { rootId: 3, fsPrefix: "/alice/.trash" },
    ]);
  });

  it("maps a Trash inside a mounted folder through that mount", () => {
    expect(trashExclusion([home, mount], "/Shared with me/Projects/.trash", { files: 3 })).toEqual([
      { rootId: 3, fsPrefix: "/bob/Projects/.trash" },
    ]);
  });

  it("is empty without a Trash, outside every scope, or on a root the index lacks", () => {
    expect(trashExclusion([home], null, { files: 3 })).toEqual([]);
    expect(trashExclusion([mount], "/.trash", { files: 3 })).toEqual([]);
    expect(trashExclusion([home], "/.trash", {})).toEqual([]);
  });
});
