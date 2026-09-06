import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { ApiHttpError } from "../errors.js";
import { createTokenService } from "./service.js";

const FIXED_CLOCK = () => new Date("2026-01-01T00:00:00.000Z");

let usernameCounter = 0;

async function seedAccountWithIdentity(repos: ReturnType<typeof createMemoryRepos>) {
  const username = `alice-${++usernameCounter}`;
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo:8080" });
  const account = await repos.accounts.create({ displayName: "Alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: username,
  });
  return { account, identity };
}

describe("createTokenService", () => {
  it("creates a token defaulting to the account's first identity", async () => {
    const repos = createMemoryRepos();
    const { account, identity } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
      generateToken: () => "fdr_fixed",
    });

    const result = await service.create(account.id, { name: "Claude" });

    expect(result.token).toBe("fdr_fixed");
    expect(result.item.name).toBe("Claude");
    expect(result.item.identityId).toBe(identity.id);
    expect(result.item.expiresAt).toBeNull();
    expect(result.item.lastUsedAt).toBeNull();
  });

  it("creates a token scoped to an explicitly given identity belonging to the account", async () => {
    const repos = createMemoryRepos();
    const { account, identity } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });

    const result = await service.create(account.id, {
      name: "Raycast",
      identityId: identity.id,
    });

    expect(result.item.identityId).toBe(identity.id);
  });

  it("rejects an identityId that does not belong to the account", async () => {
    const repos = createMemoryRepos();
    const { account } = await seedAccountWithIdentity(repos);
    const other = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });

    await expect(
      service.create(account.id, { name: "Claude", identityId: other.identity.id }),
    ).rejects.toThrow(ApiHttpError);
  });

  it("rejects an identityId that does not exist", async () => {
    const repos = createMemoryRepos();
    const { account } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });

    await expect(
      service.create(account.id, {
        name: "Claude",
        identityId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow(ApiHttpError);
  });

  it("rejects creating a token for an account with no linked identity", async () => {
    const repos = createMemoryRepos();
    const account = await repos.accounts.create({ displayName: "Orphan" });
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });

    await expect(service.create(account.id, { name: "Claude" })).rejects.toThrow(ApiHttpError);
  });

  it("computes expiresAt from expiresInDays", async () => {
    const repos = createMemoryRepos();
    const { account } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });

    const result = await service.create(account.id, { name: "Claude", expiresInDays: 30 });

    expect(result.item.expiresAt).toBe("2026-01-31T00:00:00.000Z");
  });

  it("lists tokens for an account without secrets", async () => {
    const repos = createMemoryRepos();
    const { account } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });
    await service.create(account.id, { name: "Claude" });

    const listed = await service.list(account.id);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("Claude");
    expect(listed[0]).not.toHaveProperty("token");
    expect(listed[0]).not.toHaveProperty("tokenHash");
  });

  it("returns an empty list for an account with no tokens", async () => {
    const repos = createMemoryRepos();
    const { account } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });

    expect(await service.list(account.id)).toEqual([]);
  });

  it("revokes a token belonging to the account", async () => {
    const repos = createMemoryRepos();
    const { account } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });
    const created = await service.create(account.id, { name: "Claude" });

    await service.revoke(created.item.id, account.id);

    expect(await service.list(account.id)).toEqual([]);
  });

  it("revoke is a no-op for a token belonging to another account", async () => {
    const repos = createMemoryRepos();
    const { account } = await seedAccountWithIdentity(repos);
    const other = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: FIXED_CLOCK,
    });
    const created = await service.create(account.id, { name: "Claude" });

    await service.revoke(created.item.id, other.account.id);

    expect(await service.list(account.id)).toHaveLength(1);
  });
});
