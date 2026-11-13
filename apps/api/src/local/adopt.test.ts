import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { KEY_ID, seal } from "../auth/crypto.js";
import {
  type AdoptSealedPasswordsDeps,
  adoptSealedPasswords,
  LOCAL_ADOPTION_KEY,
} from "./adopt.js";
import { FAST_PASSWORDS } from "./test-fixtures/index.ts";
import { createLocalUserStore } from "./users.js";

const MASTER = new Uint8Array(Buffer.alloc(32, 21));
const OTHER_MASTER = new Uint8Array(Buffer.alloc(32, 22));

/** An installation that moved from SFTPGo: logins on the row that is now the local folder. */
async function fixture() {
  const repos = createMemoryRepos();
  const local = await repos.providers.ensure({ type: "local", baseUrl: "local" });
  const other = await repos.providers.ensure({ type: "webdav", baseUrl: "http://dav.test" });
  async function login(
    providerId: string,
    username: string,
    credential: Record<string, string> | null,
    options: { admin?: boolean; master?: Uint8Array } = {},
  ) {
    const account = await repos.accounts.create({ displayName: username });
    if (options.admin === true) await repos.accounts.setAdmin(account.id, true);
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId,
      externalUsername: username,
    });
    if (credential !== null) {
      await repos.credentials.put({
        identityId: identity.id,
        keyId: KEY_ID,
        ciphertext: seal(
          options.master ?? MASTER,
          new TextEncoder().encode(JSON.stringify(credential)),
          identity.id,
        ),
      });
    }
    return identity;
  }
  const deps: AdoptSealedPasswordsDeps = { repos, master: MASTER, passwords: FAST_PASSWORDS };
  const store = createLocalUserStore({
    repo: repos.localUsers,
    grants: repos.localGrants,
    passwords: FAST_PASSWORDS,
  });
  return { repos, local, other, login, deps, store };
}

describe("adoptSealedPasswords", () => {
  it("gives every login a user with its last password: administrators enabled, the rest disabled", async () => {
    const h = await fixture();
    await h.login(
      h.local.id,
      "alice",
      { username: "alice", password: "alice-pass" },
      { admin: true },
    );
    await h.login(h.local.id, "bob", { username: "bob", password: "bob-pass" });

    expect(await adoptSealedPasswords(h.deps, h.local.id)).toEqual({
      enabled: ["alice"],
      disabled: ["bob"],
    });
    expect(await h.store.verify("alice", "alice-pass")).toEqual({
      result: "ok",
      username: "alice",
    });
    // Bob's password carries over too; an administrator lets him in with one click.
    expect(await h.store.verify("bob", "bob-pass")).toEqual({ result: "disabled" });
    expect(await h.repos.settings.get(LOCAL_ADOPTION_KEY)).toBe(true);
  });

  it("skips what it cannot or must not carry over", async () => {
    const h = await fixture();
    // Another storage's login is someone else.
    await h.login(h.other.id, "dave", { username: "dave", password: "dave-pass" });
    // A name that cannot be a home folder.
    await h.login(h.local.id, "../etc", { username: "../etc", password: "x-pass" });
    // A login fdrive never stored a password for.
    await h.login(h.local.id, "erin", null);
    // Sealed under another master key: unreadable here.
    await h.login(h.local.id, "frank", { password: "frank-pass" }, { master: OTHER_MASTER });
    // A credential without a password, and one with an empty password.
    await h.login(h.local.id, "gina", { username: "gina" });
    await h.login(h.local.id, "hank", { password: "" });
    // A user an administrator already made keeps their own password.
    await h.repos.localUsers.create({
      username: "ivy",
      passwordHash: await FAST_PASSWORDS.hash("ivy-new"),
    });
    await h.login(h.local.id, "ivy", { password: "ivy-old" }, { admin: true });

    expect(await adoptSealedPasswords(h.deps, h.local.id)).toEqual({ enabled: [], disabled: [] });
    expect((await h.repos.localUsers.list()).map((user) => user.username)).toEqual(["ivy"]);
    expect(await h.store.verify("ivy", "ivy-new")).toMatchObject({ result: "ok" });
  });

  it("keeps the first of two logins that differ only in case", async () => {
    const h = await fixture();
    await h.login(h.local.id, "Carol", { password: "first-pass" }, { admin: true });
    await h.login(h.local.id, "carol", { password: "second-pass" }, { admin: true });
    // The second create races the first: the repository refuses it.
    const get = h.repos.localUsers.get.bind(h.repos.localUsers);
    vi.spyOn(h.repos.localUsers, "get").mockImplementation(async (username) =>
      username === "carol" ? null : get(username),
    );

    expect(await adoptSealedPasswords(h.deps, h.local.id)).toEqual({
      enabled: ["Carol"],
      disabled: [],
    });
    vi.restoreAllMocks();
    expect(await h.store.verify("carol", "first-pass")).toEqual({
      result: "ok",
      username: "Carol",
    });
  });

  it("passes any other failure to create a user through", async () => {
    const h = await fixture();
    await h.login(h.local.id, "alice", { password: "alice-pass" });
    const failure = new Error("database unavailable");
    vi.spyOn(h.repos.localUsers, "create").mockRejectedValueOnce(failure);
    await expect(adoptSealedPasswords(h.deps, h.local.id)).rejects.toBe(failure);
    // Nothing was recorded, so the next start tries again.
    expect(await h.repos.settings.get(LOCAL_ADOPTION_KEY)).toBeNull();
  });

  it("runs once, so a user removed later is not brought back", async () => {
    const h = await fixture();
    await h.login(h.local.id, "alice", { password: "alice-pass" }, { admin: true });
    expect((await adoptSealedPasswords(h.deps, h.local.id)).enabled).toEqual(["alice"]);
    await h.repos.localUsers.delete("alice");

    expect(await adoptSealedPasswords(h.deps, h.local.id)).toEqual({ enabled: [], disabled: [] });
    expect(await h.repos.localUsers.list()).toEqual([]);
  });

  it("treats an account that is gone as no administrator", async () => {
    const h = await fixture();
    await h.login(h.local.id, "zed", { password: "zed-pass" }, { admin: true });
    vi.spyOn(h.repos.accounts, "get").mockResolvedValue(null);
    expect(await adoptSealedPasswords(h.deps, h.local.id)).toEqual({
      enabled: [],
      disabled: ["zed"],
    });
  });
});
