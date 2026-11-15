import type { Scope } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { roundTripVirtualPath } from "./round-trip.ts";

const home: Scope = { fsPrefix: "/alice", virtualPrefix: "/" };
const shared: Scope = { fsPrefix: "/bob/team", virtualPrefix: "/Shared with me/team" };

describe("roundTripVirtualPath", () => {
  it("returns the virtual path for a plain home-scope file", () => {
    expect(roundTripVirtualPath([home], "/alice/report.pdf")).toBe("/report.pdf");
  });

  it("returns null when no scope covers the path", () => {
    expect(roundTripVirtualPath([home], "/bob/report.pdf")).toBeNull();
  });

  it("resolves through a shared folder for its own subtree", () => {
    expect(roundTripVirtualPath([home, shared], "/bob/team/a/b.txt")).toBe(
      "/Shared with me/team/a/b.txt",
    );
  });

  it("filters out a home file a shared folder shadows", () => {
    // /alice/Shared with me/team/secret.txt maps to the virtual path a shared
    // folder claims, which leads back to /bob/team instead.
    expect(
      roundTripVirtualPath([home, shared], "/alice/Shared with me/team/secret.txt"),
    ).toBeNull();
  });

  it("keeps the home's own Shared with me out of sight, shared or not", () => {
    for (const scopes of [[home], [home, shared]]) {
      expect(roundTripVirtualPath(scopes, "/alice/Shared with me")).toBeNull();
      expect(roundTripVirtualPath(scopes, "/alice/Shared with me/mine.txt")).toBeNull();
      expect(roundTripVirtualPath(scopes, "/alice/Shared with me/other/a.txt")).toBeNull();
    }
    expect(roundTripVirtualPath([home], "/alice/Shared with meet/a.txt")).toBe(
      "/Shared with meet/a.txt",
    );
  });

  it("maps a folder shared inside another shared folder through the inner one", () => {
    const outer: Scope = { fsPrefix: "/bob", virtualPrefix: "/Shared with me/bob" };
    expect(roundTripVirtualPath([home, outer, shared], "/bob/team/x")).toBe(
      "/Shared with me/team/x",
    );
    expect(roundTripVirtualPath([home, outer, shared], "/bob/other")).toBe(
      "/Shared with me/bob/other",
    );
  });
});
