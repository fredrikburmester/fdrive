import { ROUTES } from "@fdrive/contracts";
import { SETUP_OWNER_KEY } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { authHarness } from "../auth/test-fixtures/index.ts";
import { createSetupService, type SetupCompleteInput } from "./service.js";

/**
 * Setup over the auth harness, so the owner is signed in through the real
 * password check. Without `local` the deployment sets no
 * `FDRIVE_STORAGE_ROOT`; with `pinned: false` its row is missing.
 */
async function harness(options: { local?: boolean; pinned?: boolean } = {}) {
  const h = authHarness();
  const row = await h.seeded;
  const service = createSetupService({
    authService: h.auth.service,
    logins: h.repos.logins,
    settings: h.repos.settings,
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
  it("is required until an owner record says setup is complete", async () => {
    const h = await harness();
    // Users alone do not complete setup; only the owner record does.
    expect(await h.service.status()).toEqual({ required: true, storageConfigured: true });
    for (const record of [
      { state: "claiming", accountId: "account-1" },
      { version: 1, state: "abandoned", accountId: "account-1" },
      "complete",
    ]) {
      await h.repos.settings.set(SETUP_OWNER_KEY, record);
      expect((await h.service.status()).required).toBe(true);
    }
    await h.repos.settings.set(SETUP_OWNER_KEY, { state: "complete", accountId: "account-1" });
    expect(await h.service.status()).toEqual({ required: false, storageConfigured: true });
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
    const me = await h.call(ROUTES.auth.me, { cookie: `fdrive_session=${result.sessionId}` });
    expect(me.status).toBe(200);
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

  it("refuses a name that is taken in any case, leaving no owner, and can run again", async () => {
    const h = await harness();
    const before = await h.state();
    await expect(h.service.complete({ ...INPUT, username: "ALICE" })).rejects.toMatchObject({
      kind: "conflict",
      message: "a user with this name already exists",
    });
    expect(await h.state()).toEqual(before);
    expect((await h.service.status()).required).toBe(true);
    await h.service.complete(INPUT);
    expect((await h.service.status()).required).toBe(false);
  });

  it("refuses a second owner and leaves nothing of them", async () => {
    const h = await harness();
    await h.service.complete(INPUT);
    const before = await h.state();
    await expect(
      h.service.complete({ ...INPUT, username: "intruder", password: "another one" }),
    ).rejects.toMatchObject({
      kind: "conflict",
      message: "this server has already been claimed by another owner",
    });
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
    expect(users.filter((name) => name === "owner" || name === "rival")).toHaveLength(1);
    expect(logins.filter((name) => name === "owner" || name === "rival")).toHaveLength(1);
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
});
