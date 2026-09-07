import type { Scope } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { roundTripVirtualPath } from "./round-trip.ts";

const home: Scope = { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" };
const sharedOverride: Scope = {
  rootName: "sftpgo",
  fsPrefix: "/pool/team",
  virtualPrefix: "/shared",
};

describe("roundTripVirtualPath", () => {
  it("returns the virtual path for a plain home-scope file", () => {
    expect(roundTripVirtualPath([home], "sftpgo", "/alice/report.pdf")).toBe("/report.pdf");
  });

  it("returns null when no scope covers the filesystem path", () => {
    expect(roundTripVirtualPath([home], "sftpgo", "/bob/report.pdf")).toBeNull();
  });

  it("returns null when the root does not match", () => {
    expect(roundTripVirtualPath([home], "other-root", "/alice/report.pdf")).toBeNull();
  });

  it("resolves through an override for its own subtree", () => {
    expect(roundTripVirtualPath([home, sharedOverride], "sftpgo", "/pool/team/x.txt")).toBe(
      "/shared/x.txt",
    );
  });

  it("filters out a home-root file shadowed by a more specific override", () => {
    // /alice/shared/secret.txt lives under home's fsPrefix, but the /shared
    // virtual name is claimed by a different, more specific override whose
    // own fsPrefix is /pool/team. The round trip must not land back on
    // /alice/shared/secret.txt, so this must be filtered out entirely.
    expect(
      roundTripVirtualPath([home, sharedOverride], "sftpgo", "/alice/shared/secret.txt"),
    ).toBeNull();
  });

  it("round trips the override's own root name and path exactly", () => {
    const virtualPath = roundTripVirtualPath([home, sharedOverride], "sftpgo", "/pool/team/a/b");
    expect(virtualPath).toBe("/shared/a/b");
  });

  it("filters out a path that round trips to a different root entirely", () => {
    // A file physically at /alice/shared/x on root "sftpgo" maps to the
    // virtual path "/shared/x" through the home scope, but that virtual
    // path resolves back to the *other* root through the override. The
    // round trip must be rejected on the root mismatch, not only the path.
    const crossRootOverride: Scope = {
      rootName: "other-root",
      fsPrefix: "/b",
      virtualPrefix: "/shared",
    };
    expect(roundTripVirtualPath([home, crossRootOverride], "sftpgo", "/alice/shared/x")).toBeNull();
  });
});
