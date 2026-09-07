import type { Scope } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { shadowedChildNames, verifyMountDirectory } from "./directory-verify.ts";
import type { DirectoryEntryLite } from "./types.ts";

const home: Scope = { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" };
const sharedOverride: Scope = {
  rootName: "sftpgo",
  fsPrefix: "/pool/team",
  virtualPrefix: "/shared",
};
const nestedOverride: Scope = {
  rootName: "sftpgo",
  fsPrefix: "/pool/deep",
  virtualPrefix: "/shared/deep",
};

describe("shadowedChildNames", () => {
  it("returns empty for a scope with no more specific overrides", () => {
    expect(shadowedChildNames(home, [home])).toEqual(new Set());
  });

  it("excludes the direct child name claimed by a more specific override", () => {
    expect(shadowedChildNames(home, [home, sharedOverride])).toEqual(new Set(["shared"]));
  });

  it("only excludes the immediate child segment, not deeper nesting", () => {
    // /shared/deep is two segments below home's virtualPrefix "/"; only
    // "shared" (the immediate child) is excluded from home's own listing.
    expect(shadowedChildNames(home, [home, nestedOverride])).toEqual(new Set(["shared"]));
  });

  it("excludes the immediate child from the intermediate scope itself", () => {
    expect(shadowedChildNames(sharedOverride, [home, sharedOverride, nestedOverride])).toEqual(
      new Set(["deep"]),
    );
  });

  it("shadows a child name even when the override points at a different root", () => {
    // The virtual namespace is shared across roots: an override mapping
    // "/other" to a different root still shadows that name from home's
    // own listing, since a user browsing "/" sees the override there.
    const otherRoot: Scope = { rootName: "other-root", fsPrefix: "/x", virtualPrefix: "/other" };
    expect(shadowedChildNames(home, [home, otherRoot])).toEqual(new Set(["other"]));
  });
});

describe("verifyMountDirectory", () => {
  const file: DirectoryEntryLite = { name: "a.txt", kind: "file" };
  const dir: DirectoryEntryLite = { name: "sub", kind: "dir" };

  it("passes when every SFTP entry matches the index with the same kind", () => {
    expect(
      verifyMountDirectory({
        sftpEntries: [file, dir],
        indexEntries: [file, dir],
        indexOverflow: false,
        excludedNames: new Set(),
      }),
    ).toEqual({ ok: true });
  });

  it("passes with extra index-only entries (SFTP hidden filters)", () => {
    expect(
      verifyMountDirectory({
        sftpEntries: [file],
        indexEntries: [file, { name: ".hidden", kind: "file" }],
        indexOverflow: false,
        excludedNames: new Set(),
      }),
    ).toEqual({ ok: true });
  });

  it("passes trivially with an empty SFTP listing", () => {
    expect(
      verifyMountDirectory({
        sftpEntries: [],
        indexEntries: [],
        indexOverflow: false,
        excludedNames: new Set(),
      }),
    ).toEqual({ ok: true });
  });

  it("fails when an SFTP entry is missing from the index", () => {
    expect(
      verifyMountDirectory({
        sftpEntries: [file],
        indexEntries: [],
        indexOverflow: false,
        excludedNames: new Set(),
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("fails when the kind differs", () => {
    expect(
      verifyMountDirectory({
        sftpEntries: [{ name: "x", kind: "dir" }],
        indexEntries: [{ name: "x", kind: "file" }],
        indexOverflow: false,
        excludedNames: new Set(),
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("ignores a shadowed name even when it is entirely absent from the index", () => {
    expect(
      verifyMountDirectory({
        sftpEntries: [{ name: "shared", kind: "dir" }],
        indexEntries: [],
        indexOverflow: false,
        excludedNames: new Set(["shared"]),
      }),
    ).toEqual({ ok: true });
  });

  it("fails on an overflowed index listing regardless of entries", () => {
    expect(
      verifyMountDirectory({
        sftpEntries: [],
        indexEntries: [],
        indexOverflow: true,
        excludedNames: new Set(),
      }),
    ).toEqual({ ok: false, reason: "overflow" });
  });
});
