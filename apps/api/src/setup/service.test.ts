import type { MeResponse } from "@fdrive/contracts";
import type { Provider } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import type { AuthService, LoginResult } from "../auth/service.js";
import { ApiHttpError } from "../errors.js";
import { createLocalUserService } from "../local/service.js";
import { FAST_PASSWORDS, localModuleFixture } from "../local/test-fixtures/index.ts";
import { seedLocalProvider } from "../providers/test-fixtures/index.ts";
import { createSetupService, type SetupCompleteInput } from "./service.js";

const CAPABILITIES = {
  zip: false,
  setModifiedAt: false,
  atomicMove: true,
  trash: false,
  shares: false,
  office: false,
  index: false,
  shareWithPeople: false,
};
const PROVIDER_ID = "123e4567-e89b-42d3-a456-426614174000";
const ME: MeResponse = {
  account: { id: "account-1", displayName: "alice" },
  identities: [
    {
      id: "identity-1",
      username: "alice",
      providerId: PROVIDER_ID,
      providerType: "local",
      providerLabel: "x",
      capabilities: CAPABILITIES,
    },
  ],
  activeIdentityId: "identity-1",
  isAdmin: false,
};

function buildAuthService(
  loginResult: LoginResult,
): Pick<AuthService, "loginCandidate" | "me" | "logout"> {
  return {
    loginCandidate: vi.fn().mockResolvedValue(loginResult),
    logout: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue({ ...loginResult.me, isAdmin: true }),
  };
}

/**
 * Setup on a deployment with a files folder: the owner becomes its first
 * user. Without `local` the deployment sets no `FDRIVE_STORAGE_ROOT`.
 */
async function harness(options: { pinned?: boolean; local?: boolean } = {}) {
  const repos = createMemoryRepos();
  const local = localModuleFixture(repos);
  const row: Provider | null = options.pinned === false ? null : await seedLocalProvider(repos);
  const users = createLocalUserService({
    repos,
    store: local.users,
    passwords: FAST_PASSWORDS,
    master: Buffer.alloc(32, 5),
    providerId: async () => row?.id ?? null,
  });
  const authService = buildAuthService({ sessionId: "session-1", me: ME });
  const setAdmin = vi.fn();
  const deps = {
    authService,
    accounts: { setAdmin },
    identities: repos.identities,
    settings: repos.settings,
    ...(options.local === false
      ? {}
      : {
          local: {
            provider: async () => row,
            userCount: () => repos.localUsers.count(),
            users,
          },
        }),
  };
  const service = createSetupService(deps);
  return { repos, row, users, store: local.users, authService, setAdmin, service, deps };
}

const INPUT: SetupCompleteInput = {
  username: "alice",
  password: "correct horse",
  userAgent: "vitest",
  ip: "127.0.0.1",
};

describe("createSetupService: status", () => {
  it("asks for the first user while the folder has none", async () => {
    const h = await harness();
    expect(await h.service.status()).toEqual({ required: true, storageConfigured: true });
    await h.repos.localUsers.create({ username: "bob", passwordHash: "x" });
    expect(await h.service.status()).toEqual({ required: false, storageConfigured: true });
    // Remembered: removing that user later does not reopen setup.
    await h.repos.localUsers.delete("bob");
    expect((await h.service.status()).required).toBe(false);
  });

  it("stays closed when people signed in before but no local user exists", async () => {
    // An installation from before the owner record whose logins never became
    // local users: nobody may claim it as its first user.
    for (const local of [true, false]) {
      const h = await harness({ local });
      const old = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://old" });
      const account = await h.repos.accounts.create({ displayName: "alice" });
      await h.repos.identities.create({
        accountId: account.id,
        providerId: old.id,
        externalUsername: "alice",
      });
      expect(await h.repos.localUsers.count()).toBe(0);
      expect((await h.service.status()).required).toBe(false);
      // Remembered, like a user: the login going away does not reopen setup.
      expect(await h.repos.settings.get("setup.initialized.v1")).toBe(true);
    }
  });

  it("says when the deployment has no files folder", async () => {
    const h = await harness({ local: false });
    expect(await h.service.status()).toEqual({ required: true, storageConfigured: false });
  });

  it("ignores an owner record it cannot read", async () => {
    for (const record of [
      { version: 1, state: "abandoned", accountId: "account-1", baseUrl: "local" },
      { version: 2, state: "complete", accountId: "account-1", baseUrl: "local" },
      { version: 1, state: "complete", accountId: 7, baseUrl: "local" },
      { version: 1, state: "complete", accountId: "account-1" },
      "complete",
    ]) {
      const h = await harness();
      await h.repos.settings.set("setup.owner.v1", record);
      expect((await h.service.status()).required).toBe(true);
    }
  });

  it("is complete once an owner record says so, users or not", async () => {
    const h = await harness({ local: false });
    await h.repos.settings.set("setup.owner.v1", {
      version: 1,
      state: "complete",
      accountId: "account-1",
      baseUrl: "http://dav:8080",
    });
    expect(await h.service.status()).toEqual({ required: false, storageConfigured: false });
  });
});

describe("createSetupService: complete", () => {
  it("makes the owner the folder's first user and signs them in on its row", async () => {
    const h = await harness();
    const result = await h.service.complete(INPUT);

    expect(await h.store.verify("alice", "correct horse")).toEqual({
      result: "ok",
      username: "alice",
    });
    expect(h.authService.loginCandidate).toHaveBeenCalledWith(
      {
        providerId: h.row?.id,
        credential: { username: "alice", password: "correct horse" },
        userAgent: "vitest",
        ip: "127.0.0.1",
      },
      h.row?.id,
      "setup.owner.v1",
    );
    expect(h.setAdmin).toHaveBeenCalledWith("account-1", true);
    expect(result.sessionId).toBe("session-1");
    expect(result.me.isAdmin).toBe(true);
    // The pinned row was enabled already and stays as it was.
    expect(await h.repos.providers.list()).toEqual([h.row]);
    expect((await h.service.status()).required).toBe(false);
  });

  it("refuses on a deployment without a files folder, naming the variable", async () => {
    const h = await harness({ local: false });
    await expect(h.service.complete(INPUT)).rejects.toMatchObject({
      kind: "bad_request",
      message: expect.stringContaining("FDRIVE_STORAGE_ROOT"),
    });
    expect(h.authService.loginCandidate).not.toHaveBeenCalled();
    expect(await h.repos.localUsers.list()).toEqual([]);
  });

  it("refuses while the folder's row is missing", async () => {
    const h = await harness({ pinned: false });
    await expect(h.service.complete(INPUT)).rejects.toMatchObject({
      kind: "bad_request",
      message: expect.stringContaining("FDRIVE_STORAGE_ROOT"),
    });
    expect(await h.repos.localUsers.list()).toEqual([]);
  });

  it.each(["unauthorized", "conflict"] as const)(
    "removes the user it created after %s, so setup can run again",
    async (kind) => {
      const h = await harness();
      vi.mocked(h.authService.loginCandidate).mockRejectedValueOnce(
        new ApiHttpError(kind, "candidate rejected"),
      );
      await expect(h.service.complete(INPUT)).rejects.toMatchObject({ kind });
      expect(await h.repos.localUsers.list()).toEqual([]);
      expect((await h.service.status()).required).toBe(true);
      expect(h.setAdmin).not.toHaveBeenCalled();
      await h.service.complete({ ...INPUT, password: "another one" });
      expect(await h.store.verify("alice", "another one")).toMatchObject({ result: "ok" });
      expect((await h.service.status()).required).toBe(false);
    },
  );

  it("resumes with the same password after an interruption, and refuses another", async () => {
    const h = await harness();
    h.setAdmin.mockRejectedValueOnce(new Error("interrupted"));
    await expect(h.service.complete(INPUT)).rejects.toThrow("interrupted");
    expect(h.authService.logout).toHaveBeenCalledWith("session-1");
    // The user stays: the claim is pending and the same owner can finish it.
    expect((await h.repos.localUsers.list()).map((user) => user.username)).toEqual(["alice"]);
    await expect(h.service.complete({ ...INPUT, password: "not the same" })).rejects.toMatchObject({
      kind: "conflict",
    });
    const restarted = createSetupService(h.deps);
    expect((await restarted.status()).required).toBe(true);
    await restarted.complete(INPUT);
    expect((await restarted.status()).required).toBe(false);
  });

  it("reports a conflict when the claim cannot be finalized by the same owner", async () => {
    const h = await harness();
    vi.spyOn(h.repos.settings, "compareAndSet")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(h.service.complete(INPUT)).rejects.toMatchObject({ kind: "conflict" });
    expect(h.authService.logout).toHaveBeenCalledWith("session-1");
  });

  it("allows only one owner when two verified users race to claim setup", async () => {
    const h = await harness();
    const bob: MeResponse = {
      ...ME,
      account: { id: "account-2", displayName: "bob" },
      identities: ME.identities.map((identity) => ({
        ...identity,
        id: "identity-2",
        username: "bob",
      })),
      activeIdentityId: "identity-2",
    };
    vi.mocked(h.authService.loginCandidate)
      .mockResolvedValueOnce({ sessionId: "session-1", me: ME })
      .mockResolvedValueOnce({ sessionId: "session-2", me: bob });
    const results = await Promise.allSettled([
      h.service.complete(INPUT),
      h.service.complete({ ...INPUT, username: "bob", password: "bob's password" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { kind: "conflict" },
    });
    expect(h.setAdmin).toHaveBeenCalledTimes(1);
    expect(h.setAdmin).toHaveBeenCalledWith("account-1", true);
  });

  it("preserves the setup error and resumable claim when session cleanup also fails", async () => {
    const h = await harness();
    h.setAdmin.mockRejectedValueOnce(new Error("interrupted"));
    vi.mocked(h.authService.logout).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(h.service.complete(INPUT)).rejects.toThrow("interrupted");
    expect(h.authService.logout).toHaveBeenCalledWith("session-1");
    expect((await h.service.status()).required).toBe(true);
  });
});
