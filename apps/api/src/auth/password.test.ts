import { describe, expect, it, vi } from "vitest";
import { createLocalUserService } from "../local/service.js";
import { createSetupService } from "../setup/service.js";
import { createLoginLimiter } from "./login-limiter.js";
import { createPasswordCheck, loginIpKey } from "./password.ts";
import { authHarness } from "./test-fixtures/index.ts";

function store(result: "ok" | "invalid" | "disabled") {
  return {
    verify: vi.fn(async (username: string) =>
      result === "ok" ? { result, username: username.toLowerCase() } : { result },
    ),
  };
}

describe("createPasswordCheck", () => {
  it("resolves to the name as stored and clears that name's failures, not the address's", async () => {
    const limiter = createLoginLimiter({ clock: () => new Date() });
    const recordSuccess = vi.spyOn(limiter, "recordSuccess");
    const check = createPasswordCheck({ limiter, users: store("ok") });
    await expect(check({ username: "Alice", password: "pw", ip: "192.0.2.1" })).resolves.toBe(
      "alice",
    );
    expect(recordSuccess).toHaveBeenCalledWith("192.0.2.1|alice");
    expect(recordSuccess).not.toHaveBeenCalledWith(loginIpKey("192.0.2.1"));
  });

  it("counts every spelling of a name against one key, and a name no user can have as a failure", async () => {
    const limiter = createLoginLimiter({ clock: () => new Date() });
    const recordFailure = vi.spyOn(limiter, "recordFailure");
    const users = store("invalid");
    const check = createPasswordCheck({ limiter, users });
    for (const username of ["alice", "ALICE", "Alice"])
      await expect(check({ username, password: "x", ip: "192.0.2.1" })).rejects.toMatchObject({
        kind: "unauthorized",
      });
    expect(recordFailure.mock.calls.filter(([key]) => key === "192.0.2.1|alice")).toHaveLength(3);

    users.verify.mockClear();
    await expect(
      check({ username: "../etc", password: "x", ip: "198.51.100.9" }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
    expect(users.verify).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledWith(loginIpKey("198.51.100.9"));
  });

  it("refuses a disabled user without counting a failure", async () => {
    const limiter = createLoginLimiter({ clock: () => new Date() });
    const recordFailure = vi.spyOn(limiter, "recordFailure");
    const check = createPasswordCheck({ limiter, users: store("disabled") });
    await expect(
      check({ username: "carol", password: "pw", ip: "192.0.2.1" }),
    ).rejects.toMatchObject({
      kind: "forbidden",
      message: "this user may not sign in",
    });
    expect(recordFailure).not.toHaveBeenCalled();
  });
});

describe("one password check for every place a password is typed", () => {
  /** Sign-in, setup and password change wired over one check, as composition wires them. */
  async function wired() {
    const h = authHarness();
    const row = await h.seeded;
    const users = createLocalUserService({
      repos: h.repos,
      checkPassword: h.checkPassword,
      passwords: h.passwords,
      providerId: async () => row.id,
    });
    const setup = createSetupService({
      authService: h.auth.service,
      logins: h.repos.logins,
      settings: h.repos.settings,
      passwords: h.passwords,
      localProvider: async () => row,
    });
    const alice = await h.login("alice");
    const signIn = (username: string, password: string, ip: string) =>
      h.auth.service.login({ username, password, ip, userAgent: null });
    const changePassword = (currentPassword: string, ip: string) =>
      users.changeOwnPassword({
        identityId: alice.me.identity.id,
        sessionIdHash: "session",
        currentPassword,
        newPassword: "alice-new-pass",
        ip,
      });
    return { ...h, setup, signIn, changePassword };
  }

  it("lets failed sign-ins hold up a password change from the same address", async () => {
    const h = await wired();
    for (let n = 0; n < 5; n++)
      await expect(h.signIn("alice", "guess", "203.0.113.1")).rejects.toMatchObject({
        kind: "unauthorized",
      });
    await expect(h.changePassword("alice-pass", "203.0.113.1")).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("lets failed password changes hold up sign-in from the same address", async () => {
    const h = await wired();
    for (let n = 0; n < 5; n++)
      await expect(h.changePassword("guess", "203.0.113.2")).rejects.toMatchObject({
        kind: "unauthorized",
      });
    await expect(h.signIn("alice", "alice-pass", "203.0.113.2")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    await expect(h.signIn("alice", "alice-pass", "203.0.113.3")).resolves.toBeDefined();
  });

  it("signs the new owner in through the same check, so a held-up address waits there too", async () => {
    const h = await wired();
    for (let n = 0; n < 5; n++)
      await expect(h.signIn(`nobody${n}`, "guess", "203.0.113.4")).rejects.toMatchObject({
        kind: "unauthorized",
      });
    const input = { username: "owner", password: "correct horse", userAgent: null };
    await expect(h.setup.complete({ ...input, ip: "203.0.113.4" })).rejects.toMatchObject({
      kind: "rate_limited",
    });
    // The owner exists whole and signs in once the address is let through again.
    expect((await h.setup.status()).required).toBe(false);
    h.now.value = new Date(h.now.value.getTime() + 61_000);
    await expect(h.signIn("owner", "correct horse", "203.0.113.4")).resolves.toMatchObject({
      me: { isAdmin: true },
    });
  });

  it("refuses a disabled user at sign-in and at a password change", async () => {
    const h = await wired();
    await h.repos.localUsers.update("alice", { disabled: true });
    await expect(h.signIn("alice", "alice-pass", "203.0.113.5")).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(h.changePassword("alice-pass", "203.0.113.5")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });
});
