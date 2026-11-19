import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";
import { createDb, createEncryptionKeyRepo, createRepos, migrate } from "../../src/index.js";

it("keeps a login's encryption keys and its Macs' copies, gone with the keys or the token", {
  timeout: 180_000,
}, async () => {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const main = createDb(container.getConnectionUri());
  try {
    await migrate(main.db);
    const repos = createRepos(main.db);
    const account = await repos.accounts.create({ displayName: "Alice" });
    const alice = await repos.identities.create({ accountId: account.id, username: "alice" });
    const bobAccount = await repos.accounts.create({ displayName: "Bob" });
    const bob = await repos.identities.create({ accountId: bobAccount.id, username: "bob" });
    const token = (identityId: string, accountId: string, name: string) =>
      repos.apiTokens.create({
        accountId,
        identityId,
        name,
        tokenHash: `hash-${name}`,
        access: { mode: "full", paths: ["/"] },
        expiresAt: null,
      });
    const keys = createEncryptionKeyRepo(main.db);

    expect(await keys.get(alice.id)).toBeNull();
    const created = await keys.create({
      identityId: alice.id,
      recipient: "age1alice",
      passwordKey: "pw",
      recoveryKey: "rk",
    });
    expect(created).toMatchObject({ identityId: alice.id, recipient: "age1alice" });
    // A second setup never replaces the first keys.
    expect(
      await keys.create({
        identityId: alice.id,
        recipient: "age1other",
        passwordKey: "x",
        recoveryKey: "y",
      }),
    ).toBeNull();
    expect((await keys.get(alice.id))?.recipient).toBe("age1alice");

    expect(await keys.setPasswordKey(alice.id, "pw2")).toBe(true);
    expect((await keys.get(alice.id))?.passwordKey).toBe("pw2");
    expect(await keys.setPasswordKey(bob.id, "pw")).toBe(false);

    const mac = await token(alice.id, account.id, "Mac: Studio");
    const laptop = await token(alice.id, account.id, "Mac: Air");
    const bobsMac = await token(bob.id, bobAccount.id, "Mac: Bob");
    expect(await keys.setDeviceKey(mac.id, alice.id, "dk1")).toBe(true);
    expect(await keys.setDeviceKey(mac.id, alice.id, "dk1b")).toBe(true);
    expect(await keys.setDeviceKey(laptop.id, alice.id, "dk2")).toBe(true);
    // Not the login's token, or a login without keys.
    expect(await keys.setDeviceKey(bobsMac.id, alice.id, "dk")).toBe(false);
    expect(await keys.setDeviceKey(bobsMac.id, bob.id, "dk")).toBe(false);

    expect(await keys.deviceKey(mac.id)).toEqual({ recipient: "age1alice", deviceKey: "dk1b" });
    expect(await keys.deviceKey(bobsMac.id)).toBeNull();
    expect((await keys.devices(alice.id)).map((device) => device.name).sort()).toEqual([
      "Mac: Air",
      "Mac: Studio",
    ]);

    expect(await keys.removeDevice(alice.id, laptop.id)).toBe(true);
    expect(await keys.removeDevice(alice.id, laptop.id)).toBe(false);
    // A revoked token takes its copy with it.
    await repos.apiTokens.delete(mac.id, account.id);
    expect(await keys.devices(alice.id)).toEqual([]);

    const again = await token(alice.id, account.id, "Mac: Again");
    expect(await keys.setDeviceKey(again.id, alice.id, "dk3")).toBe(true);
    // Resetting deletes the keys and every Mac's copy.
    expect(await keys.remove(alice.id)).toBe(true);
    expect(await keys.remove(alice.id)).toBe(false);
    expect(await keys.get(alice.id)).toBeNull();
    expect(await keys.deviceKey(again.id)).toBeNull();
  } finally {
    await main.pool.end();
    await container.stop();
  }
});
