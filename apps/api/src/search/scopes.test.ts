import { describe, expect, it } from "vitest";
import { dateFromMtimeNs, reservedExclusion, toIndexRelativePath } from "./scopes";

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

describe("reservedExclusion", () => {
  const home = { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" };
  const mount = {
    rootName: "files",
    fsPrefix: "/bob/Projects",
    virtualPrefix: "/Shared with me/Projects",
  };
  const names = [".fdrive-move-v1", ".fdrive-backups"];

  it("maps the Trash and the Mac app's folder through the home onto its root", () => {
    expect(reservedExclusion([home, mount], "/.trash", { files: 3 })).toEqual({
      prefixes: [
        { rootId: 3, fsPrefix: "/alice/.trash" },
        { rootId: 3, fsPrefix: "/alice/.fdrive-desktop" },
      ],
      names,
    });
  });

  it("maps a Trash inside a mounted folder through that mount", () => {
    expect(
      reservedExclusion([home, mount], "/Shared with me/Projects/.trash", { files: 3 }).prefixes,
    ).toEqual([
      { rootId: 3, fsPrefix: "/bob/Projects/.trash" },
      { rootId: 3, fsPrefix: "/alice/.fdrive-desktop" },
    ]);
  });

  it("keeps only the reserved names without a Trash, outside every scope, or on a root the index lacks", () => {
    expect(reservedExclusion([home], null, { files: 3 }).prefixes).toEqual([
      { rootId: 3, fsPrefix: "/alice/.fdrive-desktop" },
    ]);
    expect(reservedExclusion([mount], "/.trash", { files: 3 })).toEqual({ prefixes: [], names });
    expect(reservedExclusion([home], "/.trash", {})).toEqual({ prefixes: [], names });
  });
});
