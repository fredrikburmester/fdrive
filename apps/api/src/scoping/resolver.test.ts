import type { ProviderModule, Scope } from "@fdrive/core";
import { createLocalModule, type LocalUsers } from "@fdrive/local";
import { describe, expect, it, vi } from "vitest";
import { fakeProviderModule } from "../providers/test-fixtures/index.ts";
import { createScopeResolver } from "./resolver.ts";
import { buildIdentity, buildProvider, fakeProviders } from "./test-fixtures/index.ts";

const users: LocalUsers = {
  verify: async () => ({ result: "invalid" }),
  status: async () => "active",
  shared: async () => [],
};

function local(indexRoot: string | null): ProviderModule {
  return createLocalModule({ root: "/srv/files", users, indexRoot });
}

const HOME: Scope = { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" };

describe("configuredMappings", () => {
  it("maps the login's home to <root>/<username> without touching storage", async () => {
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider()], () => local("files")),
      indexRootNames: [],
    });
    expect(await resolver.configuredMappings(buildIdentity())).toEqual({
      available: true,
      providerId: "provider-1",
      scopes: [HOME],
    });
  });

  it("names the provider row the identity belongs to", async () => {
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider(), buildProvider({ id: "provider-2" })], () =>
        local("files"),
      ),
      indexRootNames: ["files"],
    });
    const bob = buildIdentity({ providerId: "provider-2", externalUsername: "bob" });
    expect(await resolver.configuredMappings(bob)).toEqual({
      available: true,
      providerId: "provider-2",
      scopes: [{ rootName: "files", fsPrefix: "/bob", virtualPrefix: "/" }],
    });
  });

  it("reports provider_mismatch for a missing or disabled provider", async () => {
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider({ enabled: false })], () => local("files")),
      indexRootNames: ["files"],
    });
    expect(await resolver.configuredMappings(buildIdentity())).toEqual({
      available: false,
      reason: "provider_mismatch",
    });
    expect(await resolver.configuredMappings(buildIdentity({ providerId: "gone" }))).toEqual({
      available: false,
      reason: "provider_mismatch",
    });
  });

  it("reports no_roots for storage outside every index root", async () => {
    // The folder read under no root, and storage that names none at all.
    for (const module of [local(null), fakeProviderModule()]) {
      const resolver = createScopeResolver({
        providers: fakeProviders([buildProvider()], () => module),
        indexRootNames: ["files"],
      });
      expect(await resolver.configuredMappings(buildIdentity())).toEqual({
        available: false,
        reason: "no_roots",
      });
    }
  });

  it("reports invalid_configuration for a username that cannot name one folder", async () => {
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider()], () => local("files")),
      indexRootNames: ["files"],
    });
    for (const externalUsername of ["..", "a/b", ""]) {
      expect(await resolver.configuredMappings(buildIdentity({ externalUsername }))).toEqual({
        available: false,
        reason: "invalid_configuration",
      });
    }
  });

  it("appends extra scopes after the home, given the identity and its home", async () => {
    const shared: Scope = {
      rootName: "files",
      fsPrefix: "/bob/Photos",
      virtualPrefix: "/Shared with me/Photos",
    };
    const extraScopes = vi.fn(async () => [shared]);
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider()], () => local("files")),
      indexRootNames: ["files"],
      extraScopes,
    });
    const alice = buildIdentity();
    expect(await resolver.configuredMappings(alice)).toEqual({
      available: true,
      providerId: "provider-1",
      scopes: [HOME, shared],
    });
    expect(extraScopes).toHaveBeenCalledWith(alice, HOME);
  });

  it("asks for no extra scopes when the login has no home", async () => {
    const extraScopes = vi.fn(async () => []);
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider()], () => local(null)),
      indexRootNames: [],
      extraScopes,
    });
    await resolver.configuredMappings(buildIdentity());
    expect(extraScopes).not.toHaveBeenCalled();
  });
});

describe("verifiedIndexScopes", () => {
  it("returns the configured scopes when their root is indexed", async () => {
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider()], () => local("files")),
      indexRootNames: new Set(["files", "other"]),
    });
    expect(await resolver.verifiedIndexScopes(buildIdentity())).toEqual({
      available: true,
      scopes: [HOME],
    });
  });

  it("reports no_roots when the login's root is not indexed, though Office keeps its mapping", async () => {
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider()], () => local("files")),
      indexRootNames: ["other"],
    });
    expect(await resolver.verifiedIndexScopes(buildIdentity())).toEqual({
      available: false,
      reason: "no_roots",
    });
    expect((await resolver.configuredMappings(buildIdentity())).available).toBe(true);
  });

  it("passes on why the configured mapping is unavailable", async () => {
    const resolver = createScopeResolver({
      providers: fakeProviders([], () => local("files")),
      indexRootNames: ["files"],
    });
    expect(await resolver.verifiedIndexScopes(buildIdentity())).toEqual({
      available: false,
      reason: "provider_mismatch",
    });
  });

  it("keeps only the extra scopes on an indexed root", async () => {
    const indexedShare: Scope = {
      rootName: "files",
      fsPrefix: "/bob/Photos",
      virtualPrefix: "/Shared with me/Photos",
    };
    const elsewhere: Scope = { rootName: "nas", fsPrefix: "/team", virtualPrefix: "/Team" };
    const resolver = createScopeResolver({
      providers: fakeProviders([buildProvider()], () => local("files")),
      indexRootNames: ["files"],
      extraScopes: async () => [indexedShare, elsewhere],
    });
    expect(await resolver.verifiedIndexScopes(buildIdentity())).toEqual({
      available: true,
      scopes: [HOME, indexedShare],
    });

    const nasOnly = createScopeResolver({
      providers: fakeProviders([buildProvider()], () => local("files")),
      indexRootNames: ["nas"],
      extraScopes: async () => [indexedShare, elsewhere],
    });
    expect(await nasOnly.verifiedIndexScopes(buildIdentity())).toEqual({
      available: true,
      scopes: [elsewhere],
    });
  });
});
