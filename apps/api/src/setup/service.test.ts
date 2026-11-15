import { SETUP_OWNER_KEY } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { hashSessionId } from "../auth/sessions.js";
import { authHarness } from "../auth/test-fixtures/index.ts";
import { createSetupService, type SetupCompleteInput } from "./service.js";

/**
 * Setup over the auth harness, so the owner is signed in through the real
 * password check. The folder has no users unless `users` names some.
 */
async function harness(options: { users?: readonly string[] } = {}) {
  const h = authHarness({ users: options.users ?? [] });
  await h.seeded;
  const service = createSetupService({
    authService: h.auth.service,
    logins: h.repos.logins,
    passwords: h.passwords,
    clock: h.clock,
  });
  /** What setup left behind: the users, the logins and the owner record. */
  async function state() {
    return {
      users: (await h.repos.localUsers.list()).map((user) => user.username),
      logins: (await h.repos.identities.listAll()).map((login) => login.username),
      owner: await h.repos.settings.get(SETUP_OWNER_KEY),
    };
  }
  return { ...h, service, state };
}

const INPUT: SetupCompleteInput = {
  username: "owner",
  password: "correct horse",
  userAgent: "vitest",
  ip: "127.0.0.1",
};

describe("createSetupService: status", () => {
  it("is open only on a fresh install", async () => {
    const h = await harness();
    expect(await h.service.status()).toEqual({ required: true });
    // An owner record alone closes it.
    await h.repos.settings.set(SETUP_OWNER_KEY, { state: "complete", accountId: "account-1" });
    expect(await h.service.status()).toEqual({ required: false });

    // So does a user, with no owner record or an unfinished one, and it stays closed
    // once every user is gone, since their logins remain.
    const used = await harness({ users: ["alice"] });
    expect((await used.service.status()).required).toBe(false);
    await used.repos.settings.set(SETUP_OWNER_KEY, { state: "claiming", accountId: "account-1" });
    expect((await used.service.status()).required).toBe(false);
    await used.repos.localUsers.delete("alice");
    expect((await used.service.status()).required).toBe(false);
    await expect(used.service.complete(INPUT)).rejects.toMatchObject({ kind: "conflict" });
  });
});

describe("createSetupService: complete", () => {
  it("creates the owner as an administrator in one step and signs them in", async () => {
    const h = await harness();
    const verify = vi.spyOn(h.users, "verify");

    const result = await h.service.complete(INPUT);

    expect(result.me).toMatchObject({ identity: { username: "owner" }, isAdmin: true });
    const login = await h.repos.identities.findByUsername("owner");
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
