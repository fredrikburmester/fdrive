import type { StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { createResolveTokenPrincipal } from "./principal.js";
import { generateApiToken, hashApiToken } from "./token-format.js";

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

const FAKE_STORAGE: StorageProvider = {
  list: notImplemented,
  statFile: notImplemented,
  download: notImplemented,
  upload: notImplemented,
  mkdir: notImplemented,
  move: notImplemented,
  copy: notImplemented,
  deleteFile: notImplemented,
  deleteDir: notImplemented,
  setModifiedAt: notImplemented,
  zip: notImplemented,
};

async function seedAccountWithIdentity(repos: ReturnType<typeof createMemoryRepos>) {
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo:8080" });
  const account = await repos.accounts.create({ displayName: "Alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  return { account, identity };
}

describe("createResolveTokenPrincipal", () => {
  it("returns null for a value that does not look like a token", async () => {
    const repos = createMemoryRepos();
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => new Date(),
      storageFactory: async () => FAKE_STORAGE,
    });

    expect(await resolve("not-a-token")).toBeNull();
  });

  it("returns null for a well-formed but unknown token", async () => {
    const repos = createMemoryRepos();
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => new Date(),
      storageFactory: async () => FAKE_STORAGE,
    });

    expect(await resolve(generateApiToken())).toBeNull();
  });

  it("resolves a valid token to its identity's principal, never as admin", async () => {
    const repos = createMemoryRepos();
    const { account, identity } = await seedAccountWithIdentity(repos);
    const token = generateApiToken();
    await repos.apiTokens.create({
      accountId: account.id,
      identityId: identity.id,
      name: "Claude",
      tokenHash: hashApiToken(token),
      expiresAt: null,
    });
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      storageFactory: async (identityId) => {
        expect(identityId).toBe(identity.id);
        return FAKE_STORAGE;
      },
    });

    const principal = await resolve(token);

    expect(principal).toEqual({
      accountId: account.id,
      identityId: identity.id,
      username: "alice",
      storage: FAKE_STORAGE,
      isAdmin: false,
    });
  });

  it("returns null for an expired token", async () => {
    const repos = createMemoryRepos();
    const { account, identity } = await seedAccountWithIdentity(repos);
    const token = generateApiToken();
    await repos.apiTokens.create({
      accountId: account.id,
      identityId: identity.id,
      name: "Claude",
      tokenHash: hashApiToken(token),
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => new Date("2026-06-01T00:00:00.000Z"),
      storageFactory: async () => FAKE_STORAGE,
    });

    expect(await resolve(token)).toBeNull();
  });

  it("accepts a token exactly at its expiry boundary as expired", async () => {
    const repos = createMemoryRepos();
    const { account, identity } = await seedAccountWithIdentity(repos);
    const token = generateApiToken();
    const expiresAt = new Date("2026-01-01T00:00:00.000Z");
    await repos.apiTokens.create({
      accountId: account.id,
      identityId: identity.id,
      name: "Claude",
      tokenHash: hashApiToken(token),
      expiresAt,
    });
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => expiresAt,
      storageFactory: async () => FAKE_STORAGE,
    });

    expect(await resolve(token)).toBeNull();
  });

  it("returns null when the token has no identity", async () => {
    const repos = createMemoryRepos();
    const { account } = await seedAccountWithIdentity(repos);
    const token = generateApiToken();
    await repos.apiTokens.create({
      accountId: account.id,
      identityId: null,
      name: "Claude",
      tokenHash: hashApiToken(token),
      expiresAt: null,
    });
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => new Date(),
      storageFactory: async () => FAKE_STORAGE,
    });

    expect(await resolve(token)).toBeNull();
  });

  it("returns null when the identity no longer belongs to the token's account", async () => {
    const repos = createMemoryRepos();
    const { account, identity } = await seedAccountWithIdentity(repos);
    const otherAccount = await repos.accounts.create({ displayName: "Mallory" });
    const token = generateApiToken();
    await repos.apiTokens.create({
      accountId: otherAccount.id,
      identityId: identity.id,
      name: "Claude",
      tokenHash: hashApiToken(token),
      expiresAt: null,
    });
    void account;
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => new Date(),
      storageFactory: async () => FAKE_STORAGE,
    });

    expect(await resolve(token)).toBeNull();
  });

  it("touches lastUsedAt on first use and does not touch again within the interval", async () => {
    const repos = createMemoryRepos();
    const { account, identity } = await seedAccountWithIdentity(repos);
    const token = generateApiToken();
    const created = await repos.apiTokens.create({
      accountId: account.id,
      identityId: identity.id,
      name: "Claude",
      tokenHash: hashApiToken(token),
      expiresAt: null,
    });
    let now = new Date("2026-01-01T00:00:00.000Z");
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => now,
      storageFactory: async () => FAKE_STORAGE,
    });

    await resolve(token);
    const afterFirst = await repos.apiTokens.findByHash(hashApiToken(token));
    expect(afterFirst?.lastUsedAt).toEqual(now);

    now = new Date(now.getTime() + 10_000);
    await resolve(token);
    const afterSecond = await repos.apiTokens.findByHash(hashApiToken(token));
    expect(afterSecond?.lastUsedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));

    void created;
  });

  it("touches lastUsedAt again once the touch interval has elapsed", async () => {
    const repos = createMemoryRepos();
    const { account, identity } = await seedAccountWithIdentity(repos);
    const token = generateApiToken();
    await repos.apiTokens.create({
      accountId: account.id,
      identityId: identity.id,
      name: "Claude",
      tokenHash: hashApiToken(token),
      expiresAt: null,
    });
    let now = new Date("2026-01-01T00:00:00.000Z");
    const resolve = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => now,
      storageFactory: async () => FAKE_STORAGE,
    });

    await resolve(token);
    now = new Date(now.getTime() + 61_000);
    await resolve(token);

    const after = await repos.apiTokens.findByHash(hashApiToken(token));
    expect(after?.lastUsedAt).toEqual(now);
  });
});
