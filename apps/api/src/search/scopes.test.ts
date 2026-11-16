import { describe, expect, it } from "vitest";
import { dateFromMtimeNs, indexPrefixes, reservedExclusion, toIndexRelativePath } from "./scopes";

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

describe("indexPrefixes", () => {
  it("maps every scope onto the files folder's root", () => {
    expect(
      indexPrefixes([
        { fsPrefix: "/alice", virtualPrefix: "/" },
        { fsPrefix: "/bob/Projects", virtualPrefix: "/Shared with me/Projects" },
      ]),
    ).toEqual([
      { rootId: 1, fsPrefix: "/alice" },
      { rootId: 1, fsPrefix: "/bob/Projects" },
    ]);
  });
});

describe("reservedExclusion", () => {
  const home = { fsPrefix: "/alice", virtualPrefix: "/" };
  const mount = {
    fsPrefix: "/bob/Projects",
    virtualPrefix: "/Shared with me/Projects",
  };

  it("maps the Trash, the Mac app's folder and the home's own Shared with me through the home", () => {
    expect(reservedExclusion([home, mount])).toEqual({
      prefixes: [
        { rootId: 1, fsPrefix: "/alice/.trash" },
        { rootId: 1, fsPrefix: "/alice/.fdrive-desktop" },
        { rootId: 1, fsPrefix: "/alice/Shared with me" },
      ],
    });
  });

  it("leaves out nothing outside every scope", () => {
    expect(reservedExclusion([mount])).toEqual({ prefixes: [] });
  });
});
