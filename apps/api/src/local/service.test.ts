import { randomUUID } from "node:crypto";
import { ConflictError, type Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { open } from "../auth/crypto.js";
import { parseStoredCredential } from "../auth/token-source.js";
import { seedLocalProvider } from "../providers/test-fixtures/index.ts";
import { createLocalUserService, type LocalUserServiceDeps, type UserViewer } from "./service.js";
import { FAST_PASSWORDS, seedLocalUsers } from "./test-fixtures/index.ts";
import { createLocalUserStore } from "./users.js";

const MASTER = new Uint8Array(Buffer.alloc(32, 31));

async function fixture(options: { provider?: boolean; environmentAdmins?: string[] } = {}) {
  const repos = createMemoryRepos();
  const row = await seedLocalProvider(repos);
  const store = createLocalUserStore({
    repo: repos.localUsers,
    grants: repos.localGrants,
    passwords: FAST_PASSWORDS,
  });
  const events: string[] = [];
  const deps: LocalUserServiceDeps = {
    repos,
    store,
    passwords: FAST_PASSWORDS,
    master: MASTER,
    providerId: async () => (options.provider === false ? null : row.id),
    ...(options.environmentAdmins === undefined
      ? {}
      : { environmentAdmins: options.environmentAdmins }),
    eventLog: { record: (_subsystem, _level, message) => events.push(message) },
  };
  const service = createLocalUserService(deps);
  await seedLocalUsers(repos, [
    { username: "alice", password: "alice-pass" },
    { username: "bob", password: "bob-pass" },
  ]);
  /** A login on the local folder with its own account, as signing in creates one. */
  async function loginOf(username: string, admin = false) {
    const account = await repos.accounts.create({ displayName: username });
    if (admin) await repos.accounts.setAdmin(account.id, true);
    return repos.identities.create({
      accountId: account.id,
      providerId: row.id,
      externalUsername: username,
    });
  }
  const alice = await loginOf("alice", true);
  const viewer: UserViewer = { accountId: alice.accountId, sessionIdHash: "alice-session" };
  return { repos, row, store, events, deps, service, loginOf, alice, viewer };
}

async function sessionFor(repos: Repos, accountId: string, idHash: string) {
  await repos.sessions.create({
    idHash,
    accountId,
    activeIdentityId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: null,
    ip: null,
  });
}

const alive = async (repos: Repos, idHash: string) =>
  (await repos.sessions.getByIdHash(idHash, new Date())) !== null;

describe("createLocalUserService: list", () => {
  it("shows every user with their account's flags and last sign-in", async () => {
    const h = await fixture();
    await h.repos.identities.touchLogin(h.alice.id, new Date("2026-09-01T10:00:00Z"));
    const { available, users } = await h.service.list(h.viewer);
    expect(available).toBe(true);
    expect(users).toEqual([
      {
        username: "alice",
        disabled: false,
        isAdmin: true,
        isYou: true,
        adminByDeployment: false,
        createdAt: expect.any(String),
        lastLoginAt: "2026-09-01T10:00:00.000Z",
      },
      // Bob has never signed in, so he has no login or account yet.
      {
        username: "bob",
        disabled: false,
        isAdmin: false,
        isYou: false,
        adminByDeployment: false,
        createdAt: expect.any(String),
        lastLoginAt: null,
      },
    ]);
  });

  it("has nothing to manage on a deployment without a local folder", async () => {
    const h = await fixture({ provider: false });
    expect(await h.service.list(h.viewer)).toEqual({ available: false, users: [] });
    await expect(
      h.service.create({ username: "carol", password: "carol-pass" }, h.viewer),
    ).rejects.toMatchObject({ kind: "unsupported" });
  });
});

describe("createLocalUserService: administrators named by the deployment", () => {
  it("lists them as administrators and refuses to remove that", async () => {
    const h = await fixture({ environmentAdmins: ["bob"] });
    await h.loginOf("bob");
    const bob = (await h.service.list(h.viewer)).users.find((user) => user.username === "bob");
    expect(bob).toMatchObject({ isAdmin: true, adminByDeployment: true });
    await expect(h.service.update("bob", { isAdmin: false }, h.viewer)).rejects.toMatchObject({
      kind: "forbidden",
    });
    // Anything else about them can still change.
    expect(await h.service.update("bob", { disabled: true }, h.viewer)).toMatchObject({
      disabled: true,
      isAdmin: true,
    });
  });
});

describe("createLocalUserService: create", () => {
  it("adds a user who can sign in, with a login an administrator can promote at once", async () => {
    const h = await fixture();
    const carol = await h.service.create(
      { username: "carol", password: "carol-pass", isAdmin: true },
      h.viewer,
    );
    expect(carol).toMatchObject({ username: "carol", isAdmin: true, isYou: false });
    expect(await h.store.verify("carol", "carol-pass")).toEqual({
      result: "ok",
      username: "carol",
    });
    const identity = await h.repos.identities.findByProviderUsername(h.row.id, "carol");
    expect(identity).not.toBeNull();
    expect((await h.repos.accounts.get(identity?.accountId ?? ""))?.isAdmin).toBe(true);
    const dave = await h.service.create({ username: "dave", password: "dave-pass" }, h.viewer);
    expect(dave.isAdmin).toBe(false);
    expect(h.events).toEqual(["User added: carol", "User added: dave"]);
  });

  it("refuses a name that is taken in any case, and passes other failures through", async () => {
    const h = await fixture();
    await expect(
      h.service.create({ username: "ALICE", password: "another-pass" }, h.viewer),
    ).rejects.toMatchObject({ kind: "conflict" });
    const failure = new Error("database unavailable");
    vi.spyOn(h.repos.localUsers, "create").mockRejectedValueOnce(failure);
    await expect(
      h.service.create({ username: "carol", password: "carol-pass" }, h.viewer),
    ).rejects.toBe(failure);
  });
});

describe("createLocalUserService: update", () => {
  it("resets a password, ending every session that predates it", async () => {
    const h = await fixture();
    const bob = await h.loginOf("bob");
    await sessionFor(h.repos, bob.accountId, "bob-1");
    await sessionFor(h.repos, h.alice.accountId, "alice-session");
    const updated = await h.service.update("BOB", { password: "bob-new-pass" }, h.viewer);
    expect(updated).toMatchObject({ username: "bob", disabled: false });
    expect(await h.store.verify("bob", "bob-new-pass")).toMatchObject({ result: "ok" });
    expect(await h.store.verify("bob", "bob-pass")).toEqual({ result: "invalid" });
    expect(await alive(h.repos, "bob-1")).toBe(false);
    expect(await alive(h.repos, "alice-session")).toBe(true);
    expect(h.events).toEqual(["User bob: password reset"]);
  });

  it("keeps the administrator's own session when they reset their own password", async () => {
    const h = await fixture();
    await sessionFor(h.repos, h.alice.accountId, "alice-session");
    await sessionFor(h.repos, h.alice.accountId, "alice-phone");
    await h.service.update("alice", { password: "alice-new-pass" }, h.viewer);
    expect(await alive(h.repos, "alice-session")).toBe(true);
    expect(await alive(h.repos, "alice-phone")).toBe(false);
  });

  it("disables and enables a user, and changes who is an administrator", async () => {
    const h = await fixture();
    const bob = await h.loginOf("bob");
    await sessionFor(h.repos, bob.accountId, "bob-1");
    expect(
      await h.service.update("bob", { disabled: true, isAdmin: true }, h.viewer),
    ).toMatchObject({ disabled: true, isAdmin: true });
    expect(await alive(h.repos, "bob-1")).toBe(false);
    expect(await h.store.status("bob")).toBe("disabled");
    await sessionFor(h.repos, bob.accountId, "bob-2");
    expect(
      await h.service.update("bob", { disabled: false, isAdmin: false }, h.viewer),
    ).toMatchObject({ disabled: false, isAdmin: false });
    // Enabling ends nothing.
    expect(await alive(h.repos, "bob-2")).toBe(true);
    expect(h.events).toEqual([
      "User bob: disabled, made an administrator",
      "User bob: enabled, no longer an administrator",
    ]);
  });

  it("gives a user who never signed in a login, and records nothing for an empty change", async () => {
    const h = await fixture();
    expect(await h.repos.identities.findByProviderUsername(h.row.id, "bob")).toBeNull();
    expect(await h.service.update("bob", {}, h.viewer)).toMatchObject({ username: "bob" });
    expect(await h.repos.identities.findByProviderUsername(h.row.id, "bob")).not.toBeNull();
    expect(h.events).toEqual([]);
  });

  it("answers with the user as it was when it vanished mid-update", async () => {
    const h = await fixture();
    vi.spyOn(h.repos.localUsers, "update").mockResolvedValueOnce(null);
    expect(await h.service.update("bob", { disabled: true }, h.viewer)).toMatchObject({
      username: "bob",
      disabled: false,
    });
  });

  it("refuses to lock administrators out of their own account", async () => {
    const h = await fixture();
    for (const patch of [{ disabled: true }, { isAdmin: false }]) {
      await expect(h.service.update("alice", patch, h.viewer)).rejects.toMatchObject({
        kind: "forbidden",
      });
    }
    expect(await h.store.status("alice")).toBe("active");
    await expect(h.service.update("nobody", { disabled: true }, h.viewer)).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("createLocalUserService: remove", () => {
  it("revokes the user's sign-in, sessions, API tokens and administrator flag", async () => {
    const h = await fixture();
    const bob = await h.loginOf("bob", true);
    await sessionFor(h.repos, bob.accountId, "bob-1");
    await h.repos.apiTokens.create({
      accountId: bob.accountId,
      identityId: bob.id,
      name: "laptop",
      tokenHash: "bob-token",
      expiresAt: null,
    });

    await h.service.remove("bob", h.viewer);

    expect(await h.repos.localUsers.get("bob")).toBeNull();
    expect(await h.store.verify("bob", "bob-pass")).toEqual({ result: "invalid" });
    expect(await alive(h.repos, "bob-1")).toBe(false);
    expect(await h.repos.apiTokens.findByHash("bob-token")).toBeNull();
    expect((await h.repos.accounts.get(bob.accountId))?.isAdmin).toBe(false);
    // The login stays, so adding the name again gives back the files and data.
    expect(await h.repos.identities.get(bob.id)).not.toBeNull();
    expect(h.events).toEqual(["User removed: bob"]);
  });

  it("removes a user who never signed in", async () => {
    const h = await fixture();
    await h.service.remove("bob", h.viewer);
    expect(await h.repos.localUsers.get("bob")).toBeNull();
  });

  it("refuses to remove the administrator's own user or one that does not exist", async () => {
    const h = await fixture();
    await expect(h.service.remove("alice", h.viewer)).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(h.service.remove("nobody", h.viewer)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(await h.repos.localUsers.get("alice")).not.toBeNull();
  });
});

describe("createLocalUserService: createOwner", () => {
  it("creates setup's first user, and its undo removes it again", async () => {
    const h = await fixture();
    const undo = await h.service.createOwner("carol", "carol-pass");
    expect(await h.store.verify("carol", "carol-pass")).toMatchObject({ result: "ok" });
    await undo();
    expect(await h.repos.localUsers.get("carol")).toBeNull();
  });

  it("accepts a user that already exists with this very password, and never removes it", async () => {
    const h = await fixture();
    const undo = await h.service.createOwner("bob", "bob-pass");
    await undo();
    expect(await h.repos.localUsers.get("bob")).not.toBeNull();
    await expect(h.service.createOwner("bob", "not-bobs")).rejects.toMatchObject({
      kind: "conflict",
    });
  });

  it("reports a name taken meanwhile as a conflict and passes other failures through", async () => {
    const h = await fixture();
    vi.spyOn(h.repos.localUsers, "create").mockRejectedValueOnce(new ConflictError("taken"));
    await expect(h.service.createOwner("carol", "carol-pass")).rejects.toMatchObject({
      kind: "conflict",
    });
    const failure = new Error("database unavailable");
    vi.spyOn(h.repos.localUsers, "create").mockRejectedValueOnce(failure);
    await expect(h.service.createOwner("carol", "carol-pass")).rejects.toBe(failure);
  });

  it("refuses on a deployment without a local folder", async () => {
    const h = await fixture({ provider: false });
    await expect(h.service.createOwner("carol", "carol-pass")).rejects.toMatchObject({
      kind: "unsupported",
    });
  });
});

describe("createLocalUserService: changeOwnPassword", () => {
  it("changes the password, reseals the stored credential and ends the other sessions", async () => {
    const h = await fixture();
    await sessionFor(h.repos, h.alice.accountId, "alice-session");
    await sessionFor(h.repos, h.alice.accountId, "alice-phone");

    await h.service.changeOwnPassword({
      identityId: h.alice.id,
      sessionIdHash: "alice-session",
      currentPassword: "alice-pass",
      newPassword: "alice-new-pass",
    });

    expect(await h.store.verify("alice", "alice-new-pass")).toMatchObject({ result: "ok" });
    expect(await h.store.verify("alice", "alice-pass")).toEqual({ result: "invalid" });
    const stored = await h.repos.credentials.get(h.alice.id);
    if (stored === null) throw new Error("no credential");
    expect(parseStoredCredential(open(MASTER, stored.ciphertext, h.alice.id))).toEqual({
      username: "alice",
      password: "alice-new-pass",
    });
    expect(await alive(h.repos, "alice-session")).toBe(true);
    expect(await alive(h.repos, "alice-phone")).toBe(false);
  });

  it("refuses a wrong current password, a disabled user and a login fdrive keeps no password for", async () => {
    const h = await fixture();
    const input = {
      identityId: h.alice.id,
      sessionIdHash: "alice-session",
      currentPassword: "guess",
      newPassword: "alice-new-pass",
    };
    await expect(h.service.changeOwnPassword(input)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    await h.repos.localUsers.update("alice", { disabled: true });
    await expect(
      h.service.changeOwnPassword({ ...input, currentPassword: "alice-pass" }),
    ).rejects.toMatchObject({ kind: "forbidden" });

    // A login on a WebDAV row left from before the files folder was the only storage.
    const retired = await h.repos.providers.ensure({ type: "webdav", baseUrl: "http://dav.test" });
    const retiredLogin = await h.repos.identities.create({
      accountId: h.alice.accountId,
      providerId: retired.id,
      externalUsername: "alice",
    });
    for (const identityId of [retiredLogin.id, randomUUID()]) {
      await expect(
        h.service.changeOwnPassword({ ...input, identityId, currentPassword: "alice-pass" }),
      ).rejects.toMatchObject({ kind: "unsupported" });
    }
    expect(await h.repos.credentials.get(h.alice.id)).toBeNull();
  });
});
