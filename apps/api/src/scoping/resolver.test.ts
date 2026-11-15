import type { Scope } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { createScopeResolver } from "./resolver.ts";

const HOME: Scope = { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" };

function resolver(
  indexRootNames: Iterable<string>,
  extraScopes?: Parameters<typeof createScopeResolver>[0]["extraScopes"],
) {
  return createScopeResolver({
    storageId: "provider-1",
    rootName: "files",
    indexRootNames,
    ...(extraScopes === undefined ? {} : { extraScopes }),
  });
}

describe("configuredMappings", () => {
  it("maps the login's home to <root>/<username> without touching storage", async () => {
    expect(await resolver([]).configuredMappings("alice")).toEqual({
      available: true,
      providerId: "provider-1",
      scopes: [HOME],
    });
    expect(await resolver(["files"]).configuredMappings("bob")).toEqual({
      available: true,
      providerId: "provider-1",
      scopes: [{ rootName: "files", fsPrefix: "/bob", virtualPrefix: "/" }],
    });
  });

  it("reports invalid_configuration for a username that cannot name one folder", async () => {
    for (const username of ["..", "a/b", ""]) {
      expect(await resolver(["files"]).configuredMappings(username)).toEqual({
        available: false,
        reason: "invalid_configuration",
      });
    }
  });

  it("appends extra scopes after the home, given the username and its home", async () => {
    const shared: Scope = {
      rootName: "files",
      fsPrefix: "/bob/Photos",
      virtualPrefix: "/Shared with me/Photos",
    };
    const extraScopes = vi.fn(async () => [shared]);
    expect(await resolver(["files"], extraScopes).configuredMappings("alice")).toEqual({
      available: true,
      providerId: "provider-1",
      scopes: [HOME, shared],
    });
    expect(extraScopes).toHaveBeenCalledWith("alice", HOME);
  });

  it("asks for no extra scopes when the login has no home", async () => {
    const extraScopes = vi.fn(async () => []);
    await resolver([], extraScopes).configuredMappings("..");
    expect(extraScopes).not.toHaveBeenCalled();
  });
});

describe("verifiedIndexScopes", () => {
  it("returns the configured scopes when their root is indexed", async () => {
    expect(await resolver(new Set(["files", "other"])).verifiedIndexScopes("alice")).toEqual({
      available: true,
      scopes: [HOME],
    });
  });

  it("reports no_roots when the login's root is not indexed, though Office keeps its mapping", async () => {
    const elsewhere = resolver(["other"]);
    expect(await elsewhere.verifiedIndexScopes("alice")).toEqual({
      available: false,
      reason: "no_roots",
    });
    expect((await elsewhere.configuredMappings("alice")).available).toBe(true);
  });

  it("passes on why the configured mapping is unavailable", async () => {
    expect(await resolver(["files"]).verifiedIndexScopes("..")).toEqual({
      available: false,
      reason: "invalid_configuration",
    });
  });

  it("keeps only the extra scopes on an indexed root", async () => {
    const indexedShare: Scope = {
      rootName: "files",
      fsPrefix: "/bob/Photos",
      virtualPrefix: "/Shared with me/Photos",
    };
    const elsewhere: Scope = { rootName: "nas", fsPrefix: "/team", virtualPrefix: "/Team" };
    const extra = async () => [indexedShare, elsewhere];
    expect(await resolver(["files"], extra).verifiedIndexScopes("alice")).toEqual({
      available: true,
      scopes: [HOME, indexedShare],
    });
    expect(await resolver(["nas"], extra).verifiedIndexScopes("alice")).toEqual({
      available: true,
      scopes: [elsewhere],
    });
  });
});
