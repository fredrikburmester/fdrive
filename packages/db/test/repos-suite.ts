import { beforeEach, describe, expect, it } from "vitest";
import type { Repos } from "../src/repos/types.js";
import { ConflictError } from "../src/repos/types.js";

/**
 * Behaviour shared by every `Repos` implementation. `setup` is called
 * before each test and must return a `Repos` bound to a clean backing
 * store (a fresh in-memory map, or a truncated set of Postgres tables), so
 * tests never see state left over from a previous test.
 */
export function defineReposSuite(name: string, setup: () => Promise<Repos> | Repos): void {
  describe(`repos: ${name}`, () => {
    let repos: Repos;

    beforeEach(async () => {
      repos = await setup();
    });

    describe("providers", () => {
      it("atomically creates one provider with final fields and never overwrites it", async () => {
        const results = await Promise.allSettled(
          ["first", "second"].map((label) =>
            repos.providers.create({
              type: "sftpgo",
              baseUrl: "http://race",
              label,
              enabled: false,
              config: { root: label },
            }),
          ),
        );
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const loser = results.find((result) => result.status === "rejected");
        expect(loser).toMatchObject({ reason: expect.any(ConflictError) });
        const winner = results.find((result) => result.status === "fulfilled");
        if (winner?.status !== "fulfilled") throw new Error("missing winner");
        expect(await repos.providers.list()).toEqual([winner.value]);
        expect(winner.value).toMatchObject({
          enabled: false,
          config: { root: winner.value.label },
        });
      });

      it("reports racing readdresses as conflicts and preserves the losing row", async () => {
        const rows = await Promise.all(
          ["a", "b"].map((host) =>
            repos.providers.ensure({ type: "sftpgo", baseUrl: `http://${host}` }),
          ),
        );
        const results = await Promise.allSettled(
          rows.map((row) => repos.providers.update(row.id, { baseUrl: "http://shared" })),
        );
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.find((result) => result.status === "rejected")).toMatchObject({
          reason: expect.any(ConflictError),
        });
        expect(
          (await repos.providers.list()).filter((row) => row.baseUrl === "http://shared"),
        ).toHaveLength(1);
      });

      it("looks up a provider by canonical UUID and rejects invalid IDs", async () => {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://provider",
        });
        expect(await repos.providers.get(provider.id)).toEqual(provider);
        expect(await repos.providers.get("00000000-0000-0000-0000-000000000099")).toBeNull();
        await expect(repos.providers.get("bad")).rejects.toThrow(TypeError);
      });
      it("creates a provider on first ensure", async () => {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });

        expect(provider.type).toBe("sftpgo");
        expect(provider.baseUrl).toBe("http://sftpgo:8080");
        expect(provider.id).toEqual(expect.any(String));
        expect(provider.createdAt).toBeInstanceOf(Date);
      });

      it("is idempotent for the same (type, baseUrl)", async () => {
        const first = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });
        const second = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });

        expect(second.id).toBe(first.id);
        expect(second.createdAt).toEqual(first.createdAt);
      });

      it("creates a distinct provider for a different baseUrl", async () => {
        const first = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo-a:8080",
        });
        const second = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo-b:8080",
        });

        expect(second.id).not.toBe(first.id);
      });

      it("creates a distinct provider for a different type", async () => {
        const first = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://same:8080",
        });
        const second = await repos.providers.ensure({
          type: "other",
          baseUrl: "http://same:8080",
        });

        expect(second.id).not.toBe(first.id);
      });

      it("defaults label, config, enabled and managedByEnv, and lists oldest first", async () => {
        const first = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://a" });
        const second = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://b" });
        expect(first).toMatchObject({ label: "", config: {}, enabled: true, managedByEnv: false });
        expect((await repos.providers.list()).map((row) => row.id)).toEqual([first.id, second.id]);
      });

      it("updates fields without touching the rest and keeps ensure from resetting them", async () => {
        const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://a" });
        const updated = await repos.providers.update(provider.id, {
          label: "Home",
          config: { homeTemplate: "sftpgo:/{username}" },
          enabled: false,
          managedByEnv: true,
        });
        expect(updated).toMatchObject({
          id: provider.id,
          label: "Home",
          config: { homeTemplate: "sftpgo:/{username}" },
          enabled: false,
          managedByEnv: true,
        });
        expect(await repos.providers.update(provider.id, {})).toEqual(updated);
        expect(await repos.providers.update(provider.id, { baseUrl: "http://c" })).toMatchObject({
          baseUrl: "http://c",
          label: "Home",
        });
        expect(await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://c" })).toMatchObject(
          {
            id: provider.id,
            label: "Home",
            enabled: false,
          },
        );
        expect(
          await repos.providers.update("00000000-0000-0000-0000-000000000099", { label: "x" }),
        ).toBeNull();
      });

      it("deletes an unused provider and refuses one that identities use", async () => {
        const unused = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://unused" });
        const used = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://used" });
        const account = await repos.accounts.create({ displayName: null });
        await repos.identities.create({
          accountId: account.id,
          providerId: used.id,
          externalUsername: "alice",
        });
        expect(await repos.identities.countByProvider(used.id)).toBe(1);
        expect(await repos.identities.countByProvider(unused.id)).toBe(0);
        await repos.providers.delete(unused.id);
        expect(await repos.providers.get(unused.id)).toBeNull();
        await expect(repos.providers.delete(used.id)).rejects.toThrow(ConflictError);
        await repos.providers.delete("00000000-0000-0000-0000-000000000099");
        expect(await repos.providers.get(used.id)).not.toBeNull();
      });
    });

    describe("accounts", () => {
      it("creates an account with a display name", async () => {
        const account = await repos.accounts.create({ displayName: "Alice" });

        expect(account.displayName).toBe("Alice");
        expect(account.id).toEqual(expect.any(String));
        expect(account.isAdmin).toBe(false);
      });

      it("creates an account with a null display name", async () => {
        const account = await repos.accounts.create({ displayName: null });

        expect(account.displayName).toBeNull();
      });

      it("gets a previously created account", async () => {
        const created = await repos.accounts.create({ displayName: "Bob" });

        const fetched = await repos.accounts.get(created.id);

        expect(fetched).toEqual(created);
      });

      it("returns null for an unknown account id", async () => {
        const fetched = await repos.accounts.get("00000000-0000-0000-0000-000000000000");

        expect(fetched).toBeNull();
      });

      it("sets and clears the admin flag", async () => {
        const account = await repos.accounts.create({ displayName: "Grace" });
        expect(account.isAdmin).toBe(false);

        await repos.accounts.setAdmin(account.id, true);
        expect((await repos.accounts.get(account.id))?.isAdmin).toBe(true);

        await repos.accounts.setAdmin(account.id, false);
        expect((await repos.accounts.get(account.id))?.isAdmin).toBe(false);
      });

      it("setAdmin on an unknown account id is a no-op", async () => {
        await expect(
          repos.accounts.setAdmin("00000000-0000-0000-0000-000000000000", true),
        ).resolves.toBeUndefined();
      });
    });

    describe("identities", () => {
      async function seedProviderAndAccount() {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });
        const account = await repos.accounts.create({ displayName: "Carol" });
        return { provider, account };
      }

      it("creates an identity", async () => {
        const { provider, account } = await seedProviderAndAccount();

        const identity = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "carol",
        });

        expect(identity.accountId).toBe(account.id);
        expect(identity.providerId).toBe(provider.id);
        expect(identity.externalUsername).toBe("carol");
        expect(identity.lastLoginAt).toBeNull();
      });

      it("finds an identity by provider and username", async () => {
        const { provider, account } = await seedProviderAndAccount();
        const created = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "carol",
        });

        const found = await repos.identities.findByProviderUsername(provider.id, "carol");

        expect(found).toEqual(created);
      });

      it("returns null when no identity matches provider and username", async () => {
        const { provider } = await seedProviderAndAccount();

        const found = await repos.identities.findByProviderUsername(provider.id, "nobody");

        expect(found).toBeNull();
      });

      it("rejects a duplicate (providerId, externalUsername) pair", async () => {
        const { provider, account } = await seedProviderAndAccount();
        await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "carol",
        });

        await expect(
          repos.identities.create({
            accountId: account.id,
            providerId: provider.id,
            externalUsername: "carol",
          }),
        ).rejects.toThrow();
      });

      it("gets an identity by id, and null when missing", async () => {
        const { provider, account } = await seedProviderAndAccount();
        const created = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "carol",
        });

        expect(await repos.identities.get(created.id)).toEqual(created);
        expect(await repos.identities.get("00000000-0000-0000-0000-000000000000")).toBeNull();
      });

      it("lists every identity for an account, empty for an account with none", async () => {
        const { provider, account } = await seedProviderAndAccount();
        const otherProvider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://other:8080",
        });
        const first = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "carol",
        });
        const second = await repos.identities.create({
          accountId: account.id,
          providerId: otherProvider.id,
          externalUsername: "carol2",
        });
        const unrelatedAccount = await repos.accounts.create({ displayName: "Dave" });

        const listed = await repos.identities.listByAccount(account.id);

        expect(listed.map((identity) => identity.id).sort()).toEqual([first.id, second.id].sort());
        expect(await repos.identities.listByAccount(unrelatedAccount.id)).toEqual([]);
      });

      it("touches the login time", async () => {
        const { provider, account } = await seedProviderAndAccount();
        const created = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "carol",
        });
        const at = new Date("2026-01-01T00:00:00.000Z");

        await repos.identities.touchLogin(created.id, at);

        const fetched = await repos.identities.get(created.id);
        expect(fetched?.lastLoginAt).toEqual(at);
      });

      it("touchLogin on an unknown id is a no-op", async () => {
        await expect(
          repos.identities.touchLogin("00000000-0000-0000-0000-000000000000", new Date()),
        ).resolves.toBeUndefined();
      });

      it("listAll returns every identity across every account", async () => {
        const { provider, account } = await seedProviderAndAccount();
        const first = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "carol",
        });
        const otherAccount = await repos.accounts.create({ displayName: "Dave" });
        const second = await repos.identities.create({
          accountId: otherAccount.id,
          providerId: provider.id,
          externalUsername: "dave",
        });

        const all = await repos.identities.listAll();

        const ids = all.map((identity) => identity.id);
        expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
      });
    });

    describe("credentials", () => {
      async function seedIdentity() {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });
        const account = await repos.accounts.create({ displayName: "Erin" });
        return repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "erin",
        });
      }

      it("returns null before a credential is put", async () => {
        const identity = await seedIdentity();

        expect(await repos.credentials.get(identity.id)).toBeNull();
      });

      it("stores and retrieves a credential", async () => {
        const identity = await seedIdentity();
        const ciphertext = new Uint8Array([1, 2, 3, 4]);

        await repos.credentials.put({ identityId: identity.id, ciphertext, keyId: "master-v1" });

        const fetched = await repos.credentials.get(identity.id);
        expect(fetched?.keyId).toBe("master-v1");
        expect(Array.from(fetched?.ciphertext ?? [])).toEqual([1, 2, 3, 4]);
        expect(fetched?.cachedToken).toBeNull();
        expect(fetched?.cachedTokenExpiresAt).toBeNull();
      });

      it("overwrites an existing credential", async () => {
        const identity = await seedIdentity();
        await repos.credentials.put({
          identityId: identity.id,
          ciphertext: new Uint8Array([1]),
          keyId: "master-v1",
        });

        await repos.credentials.put({
          identityId: identity.id,
          ciphertext: new Uint8Array([9, 9]),
          keyId: "master-v2",
        });

        const fetched = await repos.credentials.get(identity.id);
        expect(fetched?.keyId).toBe("master-v2");
        expect(Array.from(fetched?.ciphertext ?? [])).toEqual([9, 9]);
      });

      it("sets and clears the cached token", async () => {
        const identity = await seedIdentity();
        await repos.credentials.put({
          identityId: identity.id,
          ciphertext: new Uint8Array([1]),
          keyId: "master-v1",
        });
        const expiresAt = new Date("2026-01-01T00:20:00.000Z");

        await repos.credentials.setCachedToken(identity.id, { sealed: "sealed-token", expiresAt });

        let fetched = await repos.credentials.get(identity.id);
        expect(fetched?.cachedToken).toBe("sealed-token");
        expect(fetched?.cachedTokenExpiresAt).toEqual(expiresAt);

        await repos.credentials.setCachedToken(identity.id, null);

        fetched = await repos.credentials.get(identity.id);
        expect(fetched?.cachedToken).toBeNull();
        expect(fetched?.cachedTokenExpiresAt).toBeNull();
      });

      it("setCachedToken on an identity with no credential row is a no-op", async () => {
        const identity = await seedIdentity();

        await expect(
          repos.credentials.setCachedToken(identity.id, {
            sealed: "x",
            expiresAt: new Date(),
          }),
        ).resolves.toBeUndefined();
        expect(await repos.credentials.get(identity.id)).toBeNull();
      });
    });

    describe("sessions", () => {
      async function seedAccount() {
        return repos.accounts.create({ displayName: "Frank" });
      }

      it("creates a session", async () => {
        const account = await seedAccount();
        const expiresAt = new Date("2026-01-02T00:00:00.000Z");

        const session = await repos.sessions.create({
          idHash: "hash-1",
          accountId: account.id,
          activeIdentityId: null,
          expiresAt,
          userAgent: "vitest",
          ip: "127.0.0.1",
        });

        expect(session.idHash).toBe("hash-1");
        expect(session.accountId).toBe(account.id);
        expect(session.activeIdentityId).toBeNull();
        expect(session.expiresAt).toEqual(expiresAt);
        expect(session.userAgent).toBe("vitest");
        expect(session.ip).toBe("127.0.0.1");
      });

      it("gets a session that has not expired", async () => {
        const account = await seedAccount();
        const expiresAt = new Date("2026-01-02T00:00:00.000Z");
        await repos.sessions.create({
          idHash: "hash-2",
          accountId: account.id,
          activeIdentityId: null,
          expiresAt,
          userAgent: null,
          ip: null,
        });

        const now = new Date("2026-01-01T00:00:00.000Z");
        const fetched = await repos.sessions.getByIdHash("hash-2", now);

        expect(fetched?.idHash).toBe("hash-2");
      });

      it("returns null for an expired session", async () => {
        const account = await seedAccount();
        const expiresAt = new Date("2026-01-01T00:00:00.000Z");
        await repos.sessions.create({
          idHash: "hash-3",
          accountId: account.id,
          activeIdentityId: null,
          expiresAt,
          userAgent: null,
          ip: null,
        });

        const now = new Date("2026-01-02T00:00:00.000Z");
        const fetched = await repos.sessions.getByIdHash("hash-3", now);

        expect(fetched).toBeNull();
      });

      it("returns null for an unknown session hash", async () => {
        const fetched = await repos.sessions.getByIdHash("no-such-hash", new Date());

        expect(fetched).toBeNull();
      });

      it("touch slides lastSeenAt and expiresAt", async () => {
        const account = await seedAccount();
        await repos.sessions.create({
          idHash: "hash-4",
          accountId: account.id,
          activeIdentityId: null,
          expiresAt: new Date("2026-01-02T00:00:00.000Z"),
          userAgent: null,
          ip: null,
        });

        const lastSeenAt = new Date("2026-01-01T12:00:00.000Z");
        const expiresAt = new Date("2026-02-01T00:00:00.000Z");
        await repos.sessions.touch("hash-4", { lastSeenAt, expiresAt });

        const fetched = await repos.sessions.getByIdHash("hash-4", lastSeenAt);
        expect(fetched?.lastSeenAt).toEqual(lastSeenAt);
        expect(fetched?.expiresAt).toEqual(expiresAt);
      });

      it("touch on an unknown hash is a no-op", async () => {
        await expect(
          repos.sessions.touch("does-not-exist", {
            lastSeenAt: new Date(),
            expiresAt: new Date(),
          }),
        ).resolves.toBeUndefined();
      });

      it("deletes a session", async () => {
        const account = await seedAccount();
        await repos.sessions.create({
          idHash: "hash-5",
          accountId: account.id,
          activeIdentityId: null,
          expiresAt: new Date("2026-01-02T00:00:00.000Z"),
          userAgent: null,
          ip: null,
        });

        await repos.sessions.delete("hash-5");

        expect(
          await repos.sessions.getByIdHash("hash-5", new Date("2026-01-01T00:00:00.000Z")),
        ).toBeNull();
      });

      it("delete on an unknown hash is a no-op", async () => {
        await expect(repos.sessions.delete("does-not-exist")).resolves.toBeUndefined();
      });

      it("deleteExpired removes only sessions expired as of now and reports the count", async () => {
        const account = await seedAccount();
        await repos.sessions.create({
          idHash: "expired-1",
          accountId: account.id,
          activeIdentityId: null,
          expiresAt: new Date("2026-01-01T00:00:00.000Z"),
          userAgent: null,
          ip: null,
        });
        await repos.sessions.create({
          idHash: "expired-2",
          accountId: account.id,
          activeIdentityId: null,
          expiresAt: new Date("2026-01-01T00:00:00.000Z"),
          userAgent: null,
          ip: null,
        });
        await repos.sessions.create({
          idHash: "still-alive",
          accountId: account.id,
          activeIdentityId: null,
          expiresAt: new Date("2026-06-01T00:00:00.000Z"),
          userAgent: null,
          ip: null,
        });

        const now = new Date("2026-02-01T00:00:00.000Z");
        const count = await repos.sessions.deleteExpired(now);

        expect(count).toBe(2);
        expect(await repos.sessions.getByIdHash("still-alive", now)).not.toBeNull();
      });
    });

    describe("apiTokens", () => {
      async function seedIdentity() {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });
        const account = await repos.accounts.create({ displayName: "Heidi" });
        const identity = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "heidi",
        });
        return { account, identity };
      }

      it("creates a token scoped to an identity", async () => {
        const { account, identity } = await seedIdentity();

        const token = await repos.apiTokens.create({
          accountId: account.id,
          identityId: identity.id,
          name: "Claude",
          tokenHash: "hash-1",
          expiresAt: null,
        });

        expect(token.accountId).toBe(account.id);
        expect(token.identityId).toBe(identity.id);
        expect(token.name).toBe("Claude");
        expect(token.tokenHash).toBe("hash-1");
        expect(token.lastUsedAt).toBeNull();
        expect(token.expiresAt).toBeNull();
        expect(token.id).toEqual(expect.any(String));
      });

      it("creates a token with no identity and an expiry", async () => {
        const { account } = await seedIdentity();
        const expiresAt = new Date("2026-06-01T00:00:00.000Z");

        const token = await repos.apiTokens.create({
          accountId: account.id,
          identityId: null,
          name: "Raycast",
          tokenHash: "hash-2",
          expiresAt,
        });

        expect(token.identityId).toBeNull();
        expect(token.expiresAt).toEqual(expiresAt);
      });

      it("finds a token by its hash", async () => {
        const { account, identity } = await seedIdentity();
        const created = await repos.apiTokens.create({
          accountId: account.id,
          identityId: identity.id,
          name: "Claude",
          tokenHash: "hash-3",
          expiresAt: null,
        });

        const found = await repos.apiTokens.findByHash("hash-3");

        expect(found).toEqual(created);
      });

      it("returns null for an unknown hash", async () => {
        expect(await repos.apiTokens.findByHash("no-such-hash")).toBeNull();
      });

      it("lists every token for an account, empty for an account with none", async () => {
        const { account, identity } = await seedIdentity();
        await repos.apiTokens.create({
          accountId: account.id,
          identityId: identity.id,
          name: "Claude",
          tokenHash: "hash-4",
          expiresAt: null,
        });
        await repos.apiTokens.create({
          accountId: account.id,
          identityId: identity.id,
          name: "Raycast",
          tokenHash: "hash-5",
          expiresAt: null,
        });
        const other = await repos.accounts.create({ displayName: "Ivan" });

        const listed = await repos.apiTokens.listByAccount(account.id);

        expect(listed.map((t) => t.name).sort()).toEqual(["Claude", "Raycast"]);
        expect(await repos.apiTokens.listByAccount(other.id)).toEqual([]);
      });

      it("touches lastUsedAt", async () => {
        const { account, identity } = await seedIdentity();
        const created = await repos.apiTokens.create({
          accountId: account.id,
          identityId: identity.id,
          name: "Claude",
          tokenHash: "hash-6",
          expiresAt: null,
        });
        const at = new Date("2026-01-01T00:00:00.000Z");

        await repos.apiTokens.touch(created.id, at);

        const found = await repos.apiTokens.findByHash("hash-6");
        expect(found?.lastUsedAt).toEqual(at);
      });

      it("touch on an unknown id is a no-op", async () => {
        await expect(
          repos.apiTokens.touch("00000000-0000-0000-0000-000000000000", new Date()),
        ).resolves.toBeUndefined();
      });

      it("deletes a token scoped to the owning account", async () => {
        const { account, identity } = await seedIdentity();
        const created = await repos.apiTokens.create({
          accountId: account.id,
          identityId: identity.id,
          name: "Claude",
          tokenHash: "hash-7",
          expiresAt: null,
        });

        await repos.apiTokens.delete(created.id, account.id);

        expect(await repos.apiTokens.findByHash("hash-7")).toBeNull();
      });

      it("does not delete a token belonging to a different account", async () => {
        const { account, identity } = await seedIdentity();
        const created = await repos.apiTokens.create({
          accountId: account.id,
          identityId: identity.id,
          name: "Claude",
          tokenHash: "hash-8",
          expiresAt: null,
        });
        const other = await repos.accounts.create({ displayName: "Judy" });

        await repos.apiTokens.delete(created.id, other.id);

        expect(await repos.apiTokens.findByHash("hash-8")).not.toBeNull();
      });

      it("delete on an unknown id is a no-op", async () => {
        const { account } = await seedIdentity();
        await expect(
          repos.apiTokens.delete("00000000-0000-0000-0000-000000000000", account.id),
        ).resolves.toBeUndefined();
      });
    });

    describe("settings", () => {
      it("returns null for a key that was never set", async () => {
        expect(await repos.settings.get("connection.sftpgo")).toBeNull();
      });

      it("stores and retrieves a JSON value", async () => {
        const value = { baseUrl: "http://sftpgo:8080", homeTemplate: "sftpgo:/{username}" };

        await repos.settings.set("connection.sftpgo", value);

        expect(await repos.settings.get("connection.sftpgo")).toEqual(value);
      });

      it("overwrites a value stored at the same key", async () => {
        await repos.settings.set("k", { a: 1 });
        await repos.settings.set("k", { a: 2 });

        expect(await repos.settings.get("k")).toEqual({ a: 2 });
      });

      it("compareAndSet creates only one concurrent absent-key claim", async () => {
        const [first, second] = await Promise.all([
          repos.settings.compareAndSet("setup.owner.v1", null, { accountId: "alice" }),
          repos.settings.compareAndSet("setup.owner.v1", null, { accountId: "bob" }),
        ]);

        expect([first, second].filter(Boolean)).toHaveLength(1);
        expect(await repos.settings.get("setup.owner.v1")).toMatchObject({
          accountId: expect.any(String),
        });
      });

      it("compareAndSet uses structural JSON equality and refuses stale values", async () => {
        await repos.settings.set("setup.owner.v1", { state: "claiming", version: 1 });

        expect(
          await repos.settings.compareAndSet(
            "setup.owner.v1",
            { version: 1, state: "claiming" },
            { version: 1, state: "complete" },
          ),
        ).toBe(true);
        expect(
          await repos.settings.compareAndSet(
            "setup.owner.v1",
            { state: "claiming", version: 1 },
            { version: 1, state: "complete", accountId: "wrong" },
          ),
        ).toBe(false);
      });

      it("lists every setting keyed by its key", async () => {
        await repos.settings.set("a", 1);
        await repos.settings.set("b", "two");

        expect(await repos.settings.all()).toEqual({ a: 1, b: "two" });
      });

      it("returns an empty object when no settings exist", async () => {
        expect(await repos.settings.all()).toEqual({});
      });
    });

    describe("tags", () => {
      async function seedAccount() {
        return repos.accounts.create({ displayName: "Kim" });
      }

      it("creates a tag", async () => {
        const account = await seedAccount();

        const tag = await repos.tags.create(account.id, { name: "Work", color: "#ff0000" });

        expect(tag.id).toEqual(expect.any(String));
        expect(tag.name).toBe("Work");
        expect(tag.color).toBe("#ff0000");
      });

      it("creates a tag with a null color", async () => {
        const account = await seedAccount();

        const tag = await repos.tags.create(account.id, { name: "Personal", color: null });

        expect(tag.color).toBeNull();
      });

      it("lists tags for an account, empty for an account with none", async () => {
        const account = await seedAccount();
        await repos.tags.create(account.id, { name: "Work", color: null });
        await repos.tags.create(account.id, { name: "Personal", color: null });
        const other = await seedAccount();

        const listed = await repos.tags.list(account.id);

        expect(listed.map((t) => t.name).sort()).toEqual(["Personal", "Work"]);
        expect(await repos.tags.list(other.id)).toEqual([]);
      });

      it("rejects a duplicate name for the same account", async () => {
        const account = await seedAccount();
        await repos.tags.create(account.id, { name: "Work", color: null });

        await expect(repos.tags.create(account.id, { name: "Work", color: null })).rejects.toThrow(
          ConflictError,
        );
      });

      it("allows the same name across different accounts", async () => {
        const account = await seedAccount();
        const other = await seedAccount();
        await repos.tags.create(account.id, { name: "Work", color: null });

        await expect(
          repos.tags.create(other.id, { name: "Work", color: null }),
        ).resolves.toBeTruthy();
      });

      it("updates a tag's name and color", async () => {
        const account = await seedAccount();
        const tag = await repos.tags.create(account.id, { name: "Work", color: null });

        const updated = await repos.tags.update(tag.id, account.id, {
          name: "Job",
          color: "#00ff00",
        });

        expect(updated).toMatchObject({ id: tag.id, name: "Job", color: "#00ff00" });
      });

      it("update returns null for a tag not owned by the account", async () => {
        const account = await seedAccount();
        const other = await seedAccount();
        const tag = await repos.tags.create(account.id, { name: "Work", color: null });

        expect(await repos.tags.update(tag.id, other.id, { name: "Stolen" })).toBeNull();
      });

      it("update rejects renaming onto an existing name", async () => {
        const account = await seedAccount();
        await repos.tags.create(account.id, { name: "Work", color: null });
        const tag = await repos.tags.create(account.id, { name: "Personal", color: null });

        await expect(repos.tags.update(tag.id, account.id, { name: "Work" })).rejects.toThrow(
          ConflictError,
        );
      });

      it("deletes a tag scoped to the owning account", async () => {
        const account = await seedAccount();
        const tag = await repos.tags.create(account.id, { name: "Work", color: null });

        await repos.tags.delete(tag.id, account.id);

        expect(await repos.tags.list(account.id)).toEqual([]);
      });

      it("does not delete a tag belonging to a different account", async () => {
        const account = await seedAccount();
        const other = await seedAccount();
        const tag = await repos.tags.create(account.id, { name: "Work", color: null });

        await repos.tags.delete(tag.id, other.id);

        expect(await repos.tags.list(account.id)).toHaveLength(1);
      });

      it("delete on an unknown id is a no-op", async () => {
        const account = await seedAccount();
        await expect(
          repos.tags.delete("00000000-0000-0000-0000-000000000000", account.id),
        ).resolves.toBeUndefined();
      });
    });

    describe("fileTags", () => {
      async function seedIdentityAndTags() {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });
        const account = await repos.accounts.create({ displayName: "Liam" });
        const identity = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "liam",
        });
        const work = await repos.tags.create(account.id, { name: "Work", color: null });
        const personal = await repos.tags.create(account.id, { name: "Personal", color: null });
        return { account, identity, work, personal };
      }

      it("returns no tags for paths with none assigned", async () => {
        const { identity } = await seedIdentityAndTags();

        const result = await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"]);

        expect(result.size).toBe(0);
      });

      it("pathsForTag, movePrefix, and deletePrefix are no-ops for an identity that never set any tags", async () => {
        const { identity, work } = await seedIdentityAndTags();

        expect(await repos.fileTags.pathsForTag(identity.id, work.id)).toEqual([]);
        await expect(
          repos.fileTags.movePrefix(identity.id, "/a.txt", "/b.txt", false),
        ).resolves.toBeUndefined();
        await expect(
          repos.fileTags.deletePrefix(identity.id, "/a.txt", false),
        ).resolves.toBeUndefined();
      });

      it("sets and reads tags for a path", async () => {
        const { identity, work, personal } = await seedIdentityAndTags();

        await repos.fileTags.setTags(identity.id, "/a.txt", [work.id, personal.id]);

        const result = await repos.fileTags.tagsForPaths(identity.id, ["/a.txt", "/b.txt"]);
        expect(result.get("/a.txt")?.sort()).toEqual([personal.id, work.id].sort());
        expect(result.has("/b.txt")).toBe(false);
      });

      it("setTags replaces the previous set", async () => {
        const { identity, work, personal } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/a.txt", [work.id]);

        await repos.fileTags.setTags(identity.id, "/a.txt", [personal.id]);

        const result = await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"]);
        expect(result.get("/a.txt")).toEqual([personal.id]);
      });

      it("setTags with an empty array clears every tag", async () => {
        const { identity, work } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/a.txt", [work.id]);

        await repos.fileTags.setTags(identity.id, "/a.txt", []);

        const result = await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"]);
        expect(result.has("/a.txt")).toBe(false);
      });

      it("pathsForTag lists every path with that tag", async () => {
        const { identity, work } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/a.txt", [work.id]);
        await repos.fileTags.setTags(identity.id, "/b.txt", [work.id]);

        const paths = await repos.fileTags.pathsForTag(identity.id, work.id);

        expect(paths.sort()).toEqual(["/a.txt", "/b.txt"]);
      });

      it("movePrefix renames an exact path", async () => {
        const { identity, work } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/a.txt", [work.id]);

        await repos.fileTags.movePrefix(identity.id, "/a.txt", "/b.txt", false);

        expect((await repos.fileTags.tagsForPaths(identity.id, ["/b.txt"])).get("/b.txt")).toEqual([
          work.id,
        ]);
        expect((await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"])).has("/a.txt")).toBe(
          false,
        );
      });

      it("movePrefix rewrites nested paths when isDir is true", async () => {
        const { identity, work } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/dir/a.txt", [work.id]);
        await repos.fileTags.setTags(identity.id, "/dir/sub/b.txt", [work.id]);
        await repos.fileTags.setTags(identity.id, "/dirsibling.txt", [work.id]);

        await repos.fileTags.movePrefix(identity.id, "/dir", "/moved", true);

        const result = await repos.fileTags.tagsForPaths(identity.id, [
          "/moved/a.txt",
          "/moved/sub/b.txt",
          "/dirsibling.txt",
        ]);
        expect(result.get("/moved/a.txt")).toEqual([work.id]);
        expect(result.get("/moved/sub/b.txt")).toEqual([work.id]);
        expect(result.get("/dirsibling.txt")).toEqual([work.id]);
      });

      it("movePrefix without isDir leaves nested paths untouched", async () => {
        const { identity, work } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/dir/a.txt", [work.id]);

        await repos.fileTags.movePrefix(identity.id, "/dir", "/moved", false);

        const result = await repos.fileTags.tagsForPaths(identity.id, ["/dir/a.txt"]);
        expect(result.get("/dir/a.txt")).toEqual([work.id]);
      });

      it("movePrefix replaces a tag already present at the destination", async () => {
        const { identity, work, personal } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/a.txt", [work.id]);
        await repos.fileTags.setTags(identity.id, "/b.txt", [personal.id]);

        await repos.fileTags.movePrefix(identity.id, "/a.txt", "/b.txt", false);

        const result = await repos.fileTags.tagsForPaths(identity.id, ["/b.txt"]);
        expect(result.get("/b.txt")).toEqual([work.id]);
      });

      it("deletePrefix removes an exact path", async () => {
        const { identity, work } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/a.txt", [work.id]);

        await repos.fileTags.deletePrefix(identity.id, "/a.txt", false);

        expect((await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"])).has("/a.txt")).toBe(
          false,
        );
      });

      it("deletePrefix removes nested paths when isDir is true", async () => {
        const { identity, work } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/dir/a.txt", [work.id]);
        await repos.fileTags.setTags(identity.id, "/dirsibling.txt", [work.id]);

        await repos.fileTags.deletePrefix(identity.id, "/dir", true);

        const result = await repos.fileTags.tagsForPaths(identity.id, [
          "/dir/a.txt",
          "/dirsibling.txt",
        ]);
        expect(result.has("/dir/a.txt")).toBe(false);
        expect(result.get("/dirsibling.txt")).toEqual([work.id]);
      });

      it("deleting a tag removes it from every path it was assigned to", async () => {
        const { identity, work, account } = await seedIdentityAndTags();
        await repos.fileTags.setTags(identity.id, "/a.txt", [work.id]);

        await repos.tags.delete(work.id, account.id);

        const result = await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"]);
        expect(result.has("/a.txt")).toBe(false);
      });
    });

    describe("favorites", () => {
      async function seedIdentity() {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });
        const account = await repos.accounts.create({ displayName: "Mona" });
        return repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "mona",
        });
      }

      it("lists no favorites initially", async () => {
        const identity = await seedIdentity();
        expect(await repos.favorites.list(identity.id)).toEqual([]);
      });

      it("movePrefix and deletePrefix are no-ops for an identity with no favorites", async () => {
        const identity = await seedIdentity();

        await expect(
          repos.favorites.movePrefix(identity.id, "/a.txt", "/b.txt", false),
        ).resolves.toBeUndefined();
        await expect(
          repos.favorites.deletePrefix(identity.id, "/a.txt", false),
        ).resolves.toBeUndefined();
      });

      it("adds and lists a favorite", async () => {
        const identity = await seedIdentity();

        await repos.favorites.add(identity.id, "/a.txt", "file");

        const listed = await repos.favorites.list(identity.id);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ path: "/a.txt", kind: "file" });
        expect(listed[0]?.createdAt).toBeInstanceOf(Date);
      });

      it("adding an already-favorited path updates its kind", async () => {
        const identity = await seedIdentity();
        await repos.favorites.add(identity.id, "/a", "file");

        await repos.favorites.add(identity.id, "/a", "dir");

        const listed = await repos.favorites.list(identity.id);
        expect(listed).toHaveLength(1);
        expect(listed[0]?.kind).toBe("dir");
      });

      it("removes a favorite", async () => {
        const identity = await seedIdentity();
        await repos.favorites.add(identity.id, "/a.txt", "file");

        await repos.favorites.remove(identity.id, "/a.txt");

        expect(await repos.favorites.list(identity.id)).toEqual([]);
      });

      it("remove on a path that is not favorited is a no-op", async () => {
        const identity = await seedIdentity();
        await expect(repos.favorites.remove(identity.id, "/nope")).resolves.toBeUndefined();
      });

      it("has returns the subset of paths that are favorited", async () => {
        const identity = await seedIdentity();
        await repos.favorites.add(identity.id, "/a.txt", "file");

        const result = await repos.favorites.has(identity.id, ["/a.txt", "/b.txt"]);

        expect(result).toEqual(new Set(["/a.txt"]));
      });

      it("has returns an empty set for an empty paths list", async () => {
        const identity = await seedIdentity();
        expect(await repos.favorites.has(identity.id, [])).toEqual(new Set());
      });

      it("movePrefix renames an exact favorited path", async () => {
        const identity = await seedIdentity();
        await repos.favorites.add(identity.id, "/a.txt", "file");

        await repos.favorites.movePrefix(identity.id, "/a.txt", "/b.txt", false);

        expect(await repos.favorites.has(identity.id, ["/b.txt"])).toEqual(new Set(["/b.txt"]));
        expect(await repos.favorites.has(identity.id, ["/a.txt"])).toEqual(new Set());
      });

      it("movePrefix rewrites a favorited folder and its nested favorites", async () => {
        const identity = await seedIdentity();
        await repos.favorites.add(identity.id, "/dir", "dir");
        await repos.favorites.add(identity.id, "/dir/a.txt", "file");

        await repos.favorites.movePrefix(identity.id, "/dir", "/moved", true);

        const listed = await repos.favorites.list(identity.id);
        expect(listed.map((f) => f.path).sort()).toEqual(["/moved", "/moved/a.txt"]);
      });

      it("movePrefix replaces a favorite already at the destination", async () => {
        const identity = await seedIdentity();
        await repos.favorites.add(identity.id, "/a.txt", "file");
        await repos.favorites.add(identity.id, "/b.txt", "dir");

        await repos.favorites.movePrefix(identity.id, "/a.txt", "/b.txt", false);

        const listed = await repos.favorites.list(identity.id);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ path: "/b.txt", kind: "file" });
      });

      it("deletePrefix removes an exact favorited path", async () => {
        const identity = await seedIdentity();
        await repos.favorites.add(identity.id, "/a.txt", "file");

        await repos.favorites.deletePrefix(identity.id, "/a.txt", false);

        expect(await repos.favorites.list(identity.id)).toEqual([]);
      });

      it("deletePrefix removes nested favorites when isDir is true", async () => {
        const identity = await seedIdentity();
        await repos.favorites.add(identity.id, "/dir/a.txt", "file");
        await repos.favorites.add(identity.id, "/other.txt", "file");

        await repos.favorites.deletePrefix(identity.id, "/dir", true);

        const listed = await repos.favorites.list(identity.id);
        expect(listed.map((f) => f.path)).toEqual(["/other.txt"]);
      });
    });

    describe("folderViews", () => {
      async function seedIdentity(username = "nora") {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });
        const account = await repos.accounts.create({ displayName: "Nora" });
        return repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: username,
        });
      }

      it("removes pins idempotently and reports exact membership", async () => {
        const identity = await seedIdentity();
        expect(await repos.folderViews.has(identity.id, "/photos")).toBe(false);
        await repos.folderViews.remove(identity.id, "/photos");
        await repos.folderViews.movePrefix(identity.id, "/missing", "/new", true);
        await repos.folderViews.deletePrefix(identity.id, "/missing", true);
        await repos.folderViews.set(identity.id, "/photos", "grid");
        expect(await repos.folderViews.has(identity.id, "/photos")).toBe(true);
        expect(await repos.folderViews.has(identity.id, "/photos/child")).toBe(false);
        await repos.folderViews.remove(identity.id, "/photos");
        await repos.folderViews.remove(identity.id, "/photos");
        expect(await repos.folderViews.get(identity.id, "/photos")).toBeNull();
      });

      it("isolates pins by identity and preserves a stored sort on a mode-only update", async () => {
        const first = await seedIdentity();
        const second = await seedIdentity("nora-second");
        await repos.folderViews.set(first.id, "/photos", "grid", {
          key: "modifiedAt",
          direction: "desc",
        });
        await repos.folderViews.set(first.id, "/photos", "list");

        expect(await repos.folderViews.get(second.id, "/photos")).toBeNull();
        expect(await repos.folderViews.get(first.id, "/photos")).toMatchObject({
          mode: "list",
          sort: { key: "modifiedAt", direction: "desc" },
        });
      });

      it("moves a pinned directory subtree, replaces conflicts, and deletes by slash boundary", async () => {
        const identity = await seedIdentity();
        await repos.folderViews.set(identity.id, "/dir", "grid");
        await repos.folderViews.set(identity.id, "/dir/nested", "tree");
        await repos.folderViews.set(identity.id, "/moved", "list");
        await repos.folderViews.set(identity.id, "/dir-sibling", "list");

        await repos.folderViews.movePrefix(identity.id, "/dir", "/moved", true);
        await repos.folderViews.movePrefix(identity.id, "/dir", "/moved", true);

        expect(await repos.folderViews.get(identity.id, "/moved")).toMatchObject({ mode: "grid" });
        expect(await repos.folderViews.get(identity.id, "/moved/nested")).toMatchObject({
          mode: "tree",
        });
        expect(await repos.folderViews.get(identity.id, "/dir-sibling")).toMatchObject({
          mode: "list",
        });

        await repos.folderViews.deletePrefix(identity.id, "/moved", true);
        expect(await repos.folderViews.get(identity.id, "/moved")).toBeNull();
        expect(await repos.folderViews.get(identity.id, "/moved/nested")).toBeNull();
        expect(await repos.folderViews.get(identity.id, "/dir-sibling")).toMatchObject({
          mode: "list",
        });
      });

      it("treats wildcard, backslash, and astral path characters literally in prefix operations", async () => {
        const identity = await seedIdentity();
        const source = "/wild%_\\🙂";
        const target = "/target🙂";
        const unrelated = "/wildAX\\🙂/child";
        await repos.folderViews.set(identity.id, `${source}/child`, "grid");
        await repos.folderViews.set(identity.id, `${target}/child`, "list");
        await repos.folderViews.set(identity.id, unrelated, "tree");

        await repos.folderViews.movePrefix(identity.id, source, target, true);

        expect(await repos.folderViews.get(identity.id, `${target}/child`)).toMatchObject({
          mode: "grid",
        });
        expect(await repos.folderViews.get(identity.id, unrelated)).toMatchObject({ mode: "tree" });
        await repos.folderViews.deletePrefix(identity.id, target, true);
        expect(await repos.folderViews.get(identity.id, `${target}/child`)).toBeNull();
        expect(await repos.folderViews.get(identity.id, unrelated)).toMatchObject({ mode: "tree" });
      });

      it("clears one identity's pins and leaves others alone", async () => {
        const first = await seedIdentity();
        const second = await seedIdentity("nora-second");
        await repos.folderViews.set(first.id, "/one", "grid");
        await repos.folderViews.set(second.id, "/two", "tree");
        await repos.folderViews.clear(first.id);

        expect(await repos.folderViews.get(first.id, "/one")).toBeNull();
        expect(await repos.folderViews.get(second.id, "/two")).toMatchObject({ mode: "tree" });
      });
    });

    describe("recents", () => {
      async function seedIdentity() {
        const provider = await repos.providers.ensure({
          type: "sftpgo",
          baseUrl: "http://sftpgo:8080",
        });
        const account = await repos.accounts.create({ displayName: "Nora" });
        return repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: "nora",
        });
      }

      it("lists nothing initially", async () => {
        const identity = await seedIdentity();
        expect(await repos.recents.list(identity.id, 10)).toEqual([]);
      });

      it("movePrefix, deletePrefix, and prune are no-ops for an identity with no recents", async () => {
        const identity = await seedIdentity();

        await expect(
          repos.recents.movePrefix(identity.id, "/a.txt", "/b.txt", false),
        ).resolves.toBeUndefined();
        await expect(
          repos.recents.deletePrefix(identity.id, "/a.txt", false),
        ).resolves.toBeUndefined();
        await expect(repos.recents.prune(identity.id, 5)).resolves.toBeUndefined();
      });

      it("touch records a path as recently opened", async () => {
        const identity = await seedIdentity();

        await repos.recents.touch(identity.id, "/a.txt");

        const listed = await repos.recents.list(identity.id, 10);
        expect(listed).toHaveLength(1);
        expect(listed[0]?.path).toBe("/a.txt");
        expect(listed[0]?.openedAt).toBeInstanceOf(Date);
      });

      it("touching an already-recent path updates its openedAt without duplicating it", async () => {
        const identity = await seedIdentity();
        await repos.recents.touch(identity.id, "/a.txt");

        await repos.recents.touch(identity.id, "/a.txt");

        expect(await repos.recents.list(identity.id, 10)).toHaveLength(1);
      });

      it("lists most recently opened first, respecting limit", async () => {
        const identity = await seedIdentity();
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        await repos.recents.touch(identity.id, "/a.txt");
        await sleep(5);
        await repos.recents.touch(identity.id, "/b.txt");
        await sleep(5);
        await repos.recents.touch(identity.id, "/c.txt");

        const listed = await repos.recents.list(identity.id, 2);

        expect(listed).toHaveLength(2);
        expect(listed.map((r) => r.path)).toEqual(["/c.txt", "/b.txt"]);
      });

      it("movePrefix renames an exact recent path", async () => {
        const identity = await seedIdentity();
        await repos.recents.touch(identity.id, "/a.txt");

        await repos.recents.movePrefix(identity.id, "/a.txt", "/b.txt", false);

        const listed = await repos.recents.list(identity.id, 10);
        expect(listed.map((r) => r.path)).toEqual(["/b.txt"]);
      });

      it("movePrefix rewrites nested recent paths when isDir is true", async () => {
        const identity = await seedIdentity();
        await repos.recents.touch(identity.id, "/dir/a.txt");

        await repos.recents.movePrefix(identity.id, "/dir", "/moved", true);

        const listed = await repos.recents.list(identity.id, 10);
        expect(listed.map((r) => r.path)).toEqual(["/moved/a.txt"]);
      });

      it("deletePrefix removes an exact recent path", async () => {
        const identity = await seedIdentity();
        await repos.recents.touch(identity.id, "/a.txt");

        await repos.recents.deletePrefix(identity.id, "/a.txt", false);

        expect(await repos.recents.list(identity.id, 10)).toEqual([]);
      });

      it("deletePrefix removes nested recents when isDir is true", async () => {
        const identity = await seedIdentity();
        await repos.recents.touch(identity.id, "/dir/a.txt");
        await repos.recents.touch(identity.id, "/other.txt");

        await repos.recents.deletePrefix(identity.id, "/dir", true);

        const listed = await repos.recents.list(identity.id, 10);
        expect(listed.map((r) => r.path)).toEqual(["/other.txt"]);
      });

      it("prune keeps only the most recently opened rows", async () => {
        const identity = await seedIdentity();
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        await repos.recents.touch(identity.id, "/a.txt");
        await sleep(5);
        await repos.recents.touch(identity.id, "/b.txt");
        await sleep(5);
        await repos.recents.touch(identity.id, "/c.txt");

        await repos.recents.prune(identity.id, 2);

        const listed = await repos.recents.list(identity.id, 10);
        expect(listed.map((r) => r.path).sort()).toEqual(["/b.txt", "/c.txt"]);
      });
    });

    describe("systemEvents", () => {
      it("returns appended entries newest first", async () => {
        await repos.systemEvents.append({ subsystem: "indexer", level: "info", message: "first" });
        await repos.systemEvents.append({
          subsystem: "indexer",
          level: "warn",
          message: "second",
          data: { root: "sftpgo" },
        });

        const listed = await repos.systemEvents.list("indexer", { limit: 10 });

        expect(listed.map((entry) => entry.message)).toEqual(["second", "first"]);
        expect(listed[0]).toMatchObject({
          subsystem: "indexer",
          level: "warn",
          source: "api",
          data: { root: "sftpgo" },
        });
        expect(listed[0]?.at).toBeInstanceOf(Date);
        expect(listed[1]?.data).toBeNull();
      });

      it("keeps each subsystem's entries separate", async () => {
        await repos.systemEvents.append({ subsystem: "indexer", level: "info", message: "idx" });
        await repos.systemEvents.append({ subsystem: "ocr", level: "info", message: "ocr" });

        expect((await repos.systemEvents.list("indexer", { limit: 10 })).map((e) => e.message)) //
          .toEqual(["idx"]);
        expect((await repos.systemEvents.list("search", { limit: 10 })).map((e) => e.message)) //
          .toEqual([]);
      });

      it("filters out entries below minLevel", async () => {
        await repos.systemEvents.append({ subsystem: "search", level: "info", message: "i" });
        await repos.systemEvents.append({ subsystem: "search", level: "warn", message: "w" });
        await repos.systemEvents.append({ subsystem: "search", level: "error", message: "e" });

        const warnPlus = await repos.systemEvents.list("search", { limit: 10, minLevel: "warn" });
        const errorsOnly = await repos.systemEvents.list("search", {
          limit: 10,
          minLevel: "error",
        });

        expect(warnPlus.map((entry) => entry.message)).toEqual(["e", "w"]);
        expect(errorsOnly.map((entry) => entry.message)).toEqual(["e"]);
      });

      it("honours limit and the before cursor", async () => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        await repos.systemEvents.append({ subsystem: "ocr", level: "info", message: "a" });
        await sleep(5);
        await repos.systemEvents.append({ subsystem: "ocr", level: "info", message: "b" });
        await sleep(5);
        await repos.systemEvents.append({ subsystem: "ocr", level: "info", message: "c" });

        const firstPage = await repos.systemEvents.list("ocr", { limit: 2 });
        expect(firstPage.map((entry) => entry.message)).toEqual(["c", "b"]);

        const cursor = firstPage[firstPage.length - 1]?.at;
        if (cursor === undefined) throw new Error("expected a cursor");
        const secondPage = await repos.systemEvents.list("ocr", { limit: 2, before: cursor });
        expect(secondPage.map((entry) => entry.message)).toEqual(["a"]);
      });

      it("prune keeps only the newest entries and ignores unknown subsystems", async () => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        await repos.systemEvents.append({ subsystem: "office", level: "info", message: "a" });
        await sleep(5);
        await repos.systemEvents.append({ subsystem: "office", level: "info", message: "b" });
        await sleep(5);
        await repos.systemEvents.append({ subsystem: "office", level: "info", message: "c" });

        await repos.systemEvents.prune("office", 2);
        await repos.systemEvents.prune("thumbnails", 2);

        expect((await repos.systemEvents.list("office", { limit: 10 })).map((e) => e.message)) //
          .toEqual(["c", "b"]);
      });
    });
  });
}
