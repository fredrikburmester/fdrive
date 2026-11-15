import { SETUP_OWNER_KEY } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { hashSessionId } from "../auth/sessions.js";
import { authHarness } from "../auth/test-fixtures/index.ts";
import { createSetupService, type SetupCompleteInput } from "./service.js";

/**
 * Setup over the auth harness, so the owner is signed in through the real
 * password check. The folder has no users unless `users` names some. Without
 * `local` the deployment sets no `FDRIVE_STORAGE_ROOT`; with `pinned: false`
 * its row is missing.
 */
async function harness(
  options: { local?: boolean; pinned?: boolean; users?: readonly string[] } = {},
) {
  const h = authHarness({ users: options.users ?? [] });
  const row = await h.seeded;
  const service = createSetupService({
    authService: h.auth.service,
    logins: h.repos.logins,
    localUsers: h.repos.localUsers,
    passwords: h.passwords,
    clock: h.clock,
    ...(options.local === false
      ? {}
      : { localProvider: async () => (options.pinned === false ? null : row) }),
  });
  /** What setup left behind: the users, the logins and the owner record. */
  async function state() {
    return {
      users: (await h.repos.localUsers.list()).map((user) => user.username),
      logins: (await h.repos.identities.listAll()).map((login) => login.externalUsername),
      owner: await h.repos.settings.get(SETUP_OWNER_KEY),
    };
  }
  return { ...h, row, service, state };
}

const INPUT: SetupCompleteInput = {
  username: "owner",
  password: "correct horse",
  userAgent: "vitest",
  ip: "127.0.0.1",
};

describe("createSetupService: status", () => {
  it("is open only while the folder has no user, whatever the owner record says", async () => {
    const h = await harness();
    // An owner record without any user does not close setup.
    await h.repos.settings.set(SETUP_OWNER_KEY, { state: "complete", accountId: "account-1" });
    expect(await h.service.status()).toEqual({ required: true, storageConfigured: true });

    const used = await harness({ users: ["alice"] });
    for (const record of [null, { state: "claiming", accountId: "account-1" }, "complete"]) {
      if (record !== null) await used.repos.settings.set(SETUP_OWNER_KEY, record);
      expect(await used.service.status()).toEqual({ required: false, storageConfigured: true });
    }
  });

  it("says when the deployment has no files folder", async () => {
    const h = await harness({ local: false });
    expect(await h.service.status()).toEqual({ required: true, storageConfigured: false });
  });
});

describe("createSetupService: complete", () => {
  it("creates the owner as an administrator in one step and signs them in", async () => {
    const h = await harness();
    const verify = vi.spyOn(h.users, "verify");

    const result = await h.service.complete(INPUT);

    expect(result.me).toMatchObject({ identity: { username: "owner" }, isAdmin: true });
    const login = await h.repos.identities.findByProviderUsername(h.row.id, "owner");
    expect(login?.id).toBe(result.me.identity.id);
    expect(await h.repos.settings.get(SETUP_OWNER_KEY)).toEqual({
      state: "complete",
      accountId: result.me.account.id,
    });
    // The session comes from the one password check, as any sign-in's does.
    expect(verify).toHaveBeenCalledWith("owner", "correct horse");
    expect(
      await h.repos.sessions.getByIdHash(hashSessionId(result.sessionId), h.clock()),
    ).toMatchObject({ identityId: result.me.identity.id });
    expect((await h.service.status()).required).toBe(false);
  });

  it("refuses on a deployment without a files folder, or while its row is missing", async () => {
    for (const options of [{ local: false }, { pinned: false }]) {
      const h = await harness(options);
      const before = await h.state();
      await expect(h.service.complete(INPUT)).rejects.toMatchObject({
        kind: "bad_request",
        message: expect.stringContaining("FDRIVE_STORAGE_ROOT"),
      });
      expect(await h.state()).toEqual(before);
    }
  });

  it("refuses a folder that has users, with no owner record or an unfinished one", async () => {
    for (const record of [null, { state: "claiming", accountId: "account-1" }]) {
      const h = await harness({ users: ["alice"] });
      if (record !== null) await h.repos.settings.set(SETUP_OWNER_KEY, record);
      const before = await h.state();
      await expect(h.service.complete(INPUT)).rejects.toMatchObject({
        kind: "conflict",
        message: "this server has already been claimed by another owner",
      });
      expect(await h.state()).toEqual(before);
    }
  });

  it("allows setup once: a second owner is refused and leaves nothing", async () => {
    const h = await harness();
    await h.service.complete(INPUT);
    const before = await h.state();
    await expect(
      h.service.complete({ ...INPUT, username: "intruder", password: "another one" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(await h.state()).toEqual(before);
  });

  it("lets only one of two racing owners finish", async () => {
    const h = await harness();
    const results = await Promise.allSettled([
      h.service.complete(INPUT),
      h.service.complete({ ...INPUT, username: "rival", password: "rival's password" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { kind: "conflict" },
    });
    const { users, logins } = await h.state();
    expect(users).toHaveLength(1);
    expect(logins).toHaveLength(1);
  });

  it("leaves no half-created owner when a step fails", async () => {
    const h = await harness();
    const before = await h.state();
    vi.spyOn(h.passwords, "hash").mockRejectedValueOnce(new Error("out of memory"));
    await expect(h.service.complete(INPUT)).rejects.toThrow("out of memory");
    expect(await h.state()).toEqual(before);
    vi.spyOn(h.repos.logins, "setup").mockRejectedValueOnce(new Error("connection lost"));
    await expect(h.service.complete(INPUT)).rejects.toThrow("connection lost");
    expect(await h.state()).toEqual(before);
    expect((await h.service.status()).required).toBe(true);
  });

  it("names a login a removed user left under another spelling as a taken name", async () => {
    const h = await harness();
    vi.spyOn(h.repos.logins, "setup").mockRejectedValueOnce(
      new (await import("@fdrive/db")).ConflictError("username already exists"),
    );
    await expect(h.service.complete(INPUT)).rejects.toMatchObject({
      kind: "conflict",
      message: "a user with this name already exists",
    });
  });
});
