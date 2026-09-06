import { beforeEach, describe, expect, it } from "vitest";
import type { Repos } from "../src/repos/types.js";

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

      it("lists every setting keyed by its key", async () => {
        await repos.settings.set("a", 1);
        await repos.settings.set("b", "two");

        expect(await repos.settings.all()).toEqual({ a: 1, b: "two" });
      });

      it("returns an empty object when no settings exist", async () => {
        expect(await repos.settings.all()).toEqual({});
      });
    });
  });
}
