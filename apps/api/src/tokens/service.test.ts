import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { ApiHttpError } from "../errors.js";
import { createTokenService } from "./service.js";

const FIXED_CLOCK = () => new Date("2026-01-01T00:00:00.000Z");

let usernameCounter = 0;

async function seedAccountWithIdentity(repos: ReturnType<typeof createMemoryRepos>) {
  const username = `alice-${++usernameCounter}`;
  const account = await repos.accounts.create({ displayName: "Alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    username,
  });
  return { account, identity, owner: { accountId: account.id, identityId: identity.id } };
}

describe("createTokenService", () => {
  it("creates a token that acts as its creator's login", async () => {
    const repos = createMemoryRepos();
    const { account, identity, owner } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      clock: FIXED_CLOCK,
      generateToken: () => "fdr_fixed",
    });

    const result = await service.create(owner, { name: "Claude" });

    expect(result.token).toBe("fdr_fixed");
    expect(result.item.name).toBe("Claude");
    expect(result.item.expiresAt).toBeNull();
    expect(result.item.lastUsedAt).toBeNull();
    const [stored] = await repos.apiTokens.listByAccount(account.id);
    expect(stored?.identityId).toBe(identity.id);
  });

  it("rejects folder access it cannot represent", async () => {
    const repos = createMemoryRepos();
    const { owner } = await seedAccountWithIdentity(repos);
    const service = createTokenService({ apiTokens: repos.apiTokens, clock: FIXED_CLOCK });

    await expect(
      service.create(owner, { name: "Bad", access: { mode: "read", paths: ["relative"] } }),
    ).rejects.toThrow(ApiHttpError);
  });

  it("computes expiresAt from expiresInDays", async () => {
    const repos = createMemoryRepos();
    const { owner } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      clock: FIXED_CLOCK,
    });

    const result = await service.create(owner, { name: "Claude", expiresInDays: 30 });

    expect(result.item.expiresAt).toBe("2026-01-31T00:00:00.000Z");
  });

  it("lists tokens for an account without secrets", async () => {
    const repos = createMemoryRepos();
    const { account, owner } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      clock: FIXED_CLOCK,
    });
    await service.create(owner, { name: "Claude" });

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
      clock: FIXED_CLOCK,
    });

    expect(await service.list(account.id)).toEqual([]);
  });

  it("revokes a token belonging to the account", async () => {
    const repos = createMemoryRepos();
    const { account, owner } = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      clock: FIXED_CLOCK,
    });
    const created = await service.create(owner, { name: "Claude" });

    await service.revoke(created.item.id, account.id);

    expect(await service.list(account.id)).toEqual([]);
  });

  it("revoke is a no-op for a token belonging to another account", async () => {
    const repos = createMemoryRepos();
    const { account, owner } = await seedAccountWithIdentity(repos);
    const other = await seedAccountWithIdentity(repos);
    const service = createTokenService({
      apiTokens: repos.apiTokens,
      clock: FIXED_CLOCK,
    });
    const created = await service.create(owner, { name: "Claude" });

    await service.revoke(created.item.id, other.account.id);

    expect(await service.list(account.id)).toHaveLength(1);
  });
});
