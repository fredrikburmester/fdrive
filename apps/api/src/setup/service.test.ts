import type { MeResponse } from "@fdrive/contracts";
import type { Provider } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import type { AuthService, LoginResult } from "../auth/service.js";
import { ApiHttpError } from "../errors.js";
import { createLocalUserService } from "../local/service.js";
import { FAST_PASSWORDS, localModuleFixture } from "../local/test-fixtures/index.ts";
import {
  memoryProviderService,
  probeFetch,
  seedLocalProvider,
  seedWebdavProvider,
} from "../providers/test-fixtures/index.ts";
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
      providerType: "webdav",
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

/** Setup on a deployment without a local folder: the owner connects WebDAV or S3. */
function harness(options: { fetch?: typeof globalThis.fetch } = {}) {
  const repos = createMemoryRepos();
  const fetchImpl = options.fetch ?? probeFetch();
  const providers = memoryProviderService(repos, { fetch: fetchImpl });
  const authService = buildAuthService({ sessionId: "session-1", me: ME });
  const setAdmin = vi.fn();
  const deps = { providers, authService, accounts: { setAdmin }, settings: repos.settings };
  const service = createSetupService(deps);
  return { repos, providers, authService, setAdmin, service, deps, fetch: fetchImpl };
}

/** Setup on a deployment with a local folder: the owner becomes its first user. */
async function localHarness(options: { pinned?: boolean } = {}) {
  const repos = createMemoryRepos();
  const local = localModuleFixture(repos);
  const providers = memoryProviderService(repos, {
    fetch: probeFetch(),
    modules: { local: local.module },
  });
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
  const service = createSetupService({
    providers,
    authService,
    accounts: { setAdmin },
    settings: repos.settings,
    local: {
      provider: async () => row,
      userCount: () => repos.localUsers.count(),
      users,
    },
  });
  return { repos, row, users, store: local.users, authService, setAdmin, service };
}

const PROVIDER_INPUT: SetupCompleteInput = {
  kind: "provider",
  type: "webdav",
  baseUrl: "http://dav:8080",
  credential: { username: "alice", password: "hunter2" },
  userAgent: "vitest",
  ip: "127.0.0.1",
};

const LOCAL_INPUT: SetupCompleteInput = {
  kind: "local",
  username: "alice",
  password: "correct horse",
  userAgent: "vitest",
  ip: "127.0.0.1",
};

describe("createSetupService: status", () => {
  it("is required with the types to choose from when nothing can sign in yet", async () => {
    const h = harness();
    expect(await h.service.status()).toEqual({
      required: true,
      mode: "provider",
      types: [
        expect.objectContaining({ type: "webdav", label: "WebDAV" }),
        expect.objectContaining({ type: "s3", label: "S3" }),
      ],
    });
  });

  it("counts an installation an administrator already enabled storage on as set up", async () => {
    const h = harness();
    await seedWebdavProvider(h.repos, "http://dav:8080");
    expect(await h.service.status()).toEqual({ required: false, mode: "provider", types: [] });
    // Remembered: disabling that storage later does not reopen setup.
    await h.repos.providers.update((await h.repos.providers.list())[0]?.id ?? "", {
      enabled: false,
    });
    expect((await h.service.status()).required).toBe(false);
  });

  it("ignores an owner record it cannot read", async () => {
    for (const record of [
      { version: 1, state: "abandoned", accountId: "account-1", baseUrl: "http://dav:8080" },
      { version: 2, state: "complete", accountId: "account-1", baseUrl: "http://dav:8080" },
      { version: 1, state: "complete", accountId: 7, baseUrl: "http://dav:8080" },
      { version: 1, state: "complete", accountId: "account-1" },
      "complete",
    ]) {
      const h = harness();
      await h.repos.settings.set("setup.owner.v1", record);
      expect((await h.service.status()).required).toBe(true);
    }
  });

  it("stays required while the only provider is disabled or pinned by the deployment", async () => {
    const h = harness();
    await seedWebdavProvider(h.repos, "http://dav:8080", { enabled: false });
    await seedWebdavProvider(h.repos, "http://env:8080", { managedByEnv: true });
    expect((await h.service.status()).required).toBe(true);
  });

  it("asks for the first local user while the folder has none", async () => {
    const h = await localHarness();
    expect(await h.service.status()).toEqual({ required: true, mode: "local", types: [] });
    await h.repos.localUsers.create({ username: "bob", passwordHash: "x" });
    expect(await h.service.status()).toEqual({ required: false, mode: "local", types: [] });
  });
});

describe("createSetupService: test", () => {
  it("probes the candidate storage through its module", async () => {
    const h = harness();
    expect(await h.service.test({ type: "webdav", baseUrl: "http://dav:8080" })).toEqual({
      ok: true,
      detail: "WebDAV is reachable (class 1, 2)",
    });
    expect(h.fetch).toHaveBeenCalledWith(
      "http://dav:8080/",
      expect.objectContaining({ method: "OPTIONS" }),
    );
    await expect(
      h.service.test({ type: "webdav", baseUrl: "http://dav:8080", config: { nope: "x" } }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });
});

describe("createSetupService: complete with a provider", () => {
  it("creates the provider disabled, logs in against it, then enables it and marks the account admin", async () => {
    const h = harness();
    let enabledDuringLogin: boolean | undefined;
    vi.mocked(h.authService.loginCandidate).mockImplementation(async (_input, providerId) => {
      enabledDuringLogin = (await h.repos.providers.get(providerId))?.enabled;
      return { sessionId: "session-1", me: ME };
    });

    const result = await h.service.complete({
      ...PROVIDER_INPUT,
      config: { desktopWriteMode: "apache-webdav-exclusive" },
    });

    const [provider] = await h.repos.providers.list();
    expect(provider).toMatchObject({
      type: "webdav",
      baseUrl: "http://dav:8080",
      label: "",
      enabled: true,
      managedByEnv: false,
      config: { desktopWriteMode: "apache-webdav-exclusive" },
    });
    expect(enabledDuringLogin).toBe(false);
    expect(h.authService.loginCandidate).toHaveBeenCalledWith(
      {
        providerId: provider?.id,
        credential: { username: "alice", password: "hunter2" },
        userAgent: "vitest",
        ip: "127.0.0.1",
      },
      provider?.id,
      "setup.owner.v1",
    );
    expect(h.setAdmin).toHaveBeenCalledWith("account-1", true);
    expect(result.sessionId).toBe("session-1");
    expect(result.me.isAdmin).toBe(true);
    expect((await h.service.status()).required).toBe(false);
  });

  it("names a new provider during setup", async () => {
    const h = harness();
    await h.service.complete({ ...PROVIDER_INPUT, label: "  Home storage  " });
    expect(await h.repos.providers.list()).toEqual([
      expect.objectContaining({ label: "Home storage", baseUrl: PROVIDER_INPUT.baseUrl }),
    ]);
  });

  it("names and enables a provider found by address only after verified ownership", async () => {
    const h = harness();
    const existing = await seedWebdavProvider(h.repos, PROVIDER_INPUT.baseUrl, {
      label: "Existing",
      enabled: false,
    });
    vi.mocked(h.authService.loginCandidate).mockRejectedValueOnce(
      new ApiHttpError("unauthorized", "bad credentials"),
    );
    await expect(
      h.service.complete({ ...PROVIDER_INPUT, label: "Home storage" }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
    // A wrong password leaves a live row as it was, and never removes it.
    expect(await h.repos.providers.get(existing.id)).toMatchObject({
      label: "Existing",
      enabled: false,
    });
    await h.service.complete({ ...PROVIDER_INPUT, label: "Home storage" });
    expect(await h.repos.providers.list()).toEqual([
      expect.objectContaining({ id: existing.id, label: "Home storage", enabled: true }),
    ]);
    // Without a label the row keeps its own.
    const unnamed = harness();
    const kept = await seedWebdavProvider(unnamed.repos, PROVIDER_INPUT.baseUrl, {
      label: "Preserved",
      enabled: false,
    });
    await unnamed.service.complete(PROVIDER_INPUT);
    expect((await unnamed.repos.providers.get(kept.id))?.label).toBe("Preserved");
  });

  it("rejects storage that does not probe ok, creating nothing", async () => {
    const h = harness({ fetch: probeFetch(false) });
    await expect(h.service.complete(PROVIDER_INPUT)).rejects.toMatchObject({
      kind: "bad_request",
      message: expect.stringContaining("The storage is not reachable"),
    });
    expect(h.authService.loginCandidate).not.toHaveBeenCalled();
    expect(await h.repos.providers.list()).toEqual([]);
  });

  it("refuses a local owner on a deployment without a local folder", async () => {
    const h = harness();
    await expect(h.service.complete(LOCAL_INPUT)).rejects.toMatchObject({
      kind: "bad_request",
      message: "this deployment serves no local folder",
    });
    expect(h.authService.loginCandidate).not.toHaveBeenCalled();
  });

  it.each(["unauthorized", "conflict"] as const)(
    "cleans a newly created candidate after %s",
    async (kind) => {
      const h = harness();
      vi.mocked(h.authService.loginCandidate).mockRejectedValueOnce(
        new ApiHttpError(kind, "candidate rejected"),
      );
      await expect(h.service.complete(PROVIDER_INPUT)).rejects.toMatchObject({ kind });
      expect(await h.repos.providers.list()).toEqual([]);
      expect((await h.service.status()).required).toBe(true);
      expect(h.setAdmin).not.toHaveBeenCalled();
      await h.service.complete(PROVIDER_INPUT);
      expect((await h.service.status()).required).toBe(false);
    },
  );

  it("keeps the login's error when removing the candidate also fails", async () => {
    const h = harness();
    vi.mocked(h.authService.loginCandidate).mockRejectedValueOnce(
      new ApiHttpError("unauthorized", "candidate rejected"),
    );
    vi.spyOn(h.providers, "remove").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(h.service.complete(PROVIDER_INPUT)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("resumes the verified owner's pending claim after restart", async () => {
    const h = harness();
    h.setAdmin.mockRejectedValueOnce(new Error("interrupted"));
    await expect(h.service.complete(PROVIDER_INPUT)).rejects.toThrow("interrupted");
    expect(h.authService.logout).toHaveBeenCalledWith("session-1");
    const restarted = createSetupService(h.deps);
    expect((await restarted.status()).required).toBe(true);
    await restarted.complete(PROVIDER_INPUT);
    expect((await restarted.status()).required).toBe(false);
  });

  it("reports a conflict when the claim cannot be finalized by the same owner", async () => {
    const h = harness();
    vi.spyOn(h.repos.settings, "compareAndSet")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(h.service.complete(PROVIDER_INPUT)).rejects.toMatchObject({ kind: "conflict" });
    expect(h.authService.logout).toHaveBeenCalledWith("session-1");
  });

  it("allows only one owner when two verified users race to claim setup", async () => {
    const h = harness();
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
    await seedWebdavProvider(h.repos, PROVIDER_INPUT.baseUrl, { enabled: false });
    const results = await Promise.allSettled([
      h.service.complete(PROVIDER_INPUT),
      h.service.complete({ ...PROVIDER_INPUT, credential: { username: "bob", password: "b" } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { kind: "conflict" },
    });
    expect(h.setAdmin).toHaveBeenCalledTimes(1);
    expect(h.setAdmin).toHaveBeenCalledWith("account-1", true);
  });

  it("preserves the setup error and resumable claim when session cleanup also fails", async () => {
    const h = harness();
    h.setAdmin.mockRejectedValueOnce(new Error("interrupted"));
    vi.mocked(h.authService.logout).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(h.service.complete(PROVIDER_INPUT)).rejects.toThrow("interrupted");
    expect(h.authService.logout).toHaveBeenCalledWith("session-1");
    expect((await h.service.status()).required).toBe(true);
  });
});

describe("createSetupService: complete with a local folder", () => {
  it("makes the owner the folder's first user and signs them in on its row", async () => {
    const h = await localHarness();
    const result = await h.service.complete(LOCAL_INPUT);

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
    expect(result.me.isAdmin).toBe(true);
    // The pinned row was enabled already and stays as it was.
    expect(await h.repos.providers.list()).toEqual([h.row]);
    expect((await h.service.status()).required).toBe(false);
  });

  it("removes the user it created when the sign-in fails, so setup can run again", async () => {
    const h = await localHarness();
    vi.mocked(h.authService.loginCandidate).mockRejectedValueOnce(
      new ApiHttpError("conflict", "already claimed"),
    );
    await expect(h.service.complete(LOCAL_INPUT)).rejects.toMatchObject({ kind: "conflict" });
    expect(await h.repos.localUsers.list()).toEqual([]);
    expect((await h.service.status()).required).toBe(true);
    await h.service.complete({ ...LOCAL_INPUT, password: "another one" });
    expect(await h.store.verify("alice", "another one")).toMatchObject({ result: "ok" });
  });

  it("resumes with the same password after an interruption, and refuses another", async () => {
    const h = await localHarness();
    h.setAdmin.mockRejectedValueOnce(new Error("interrupted"));
    await expect(h.service.complete(LOCAL_INPUT)).rejects.toThrow("interrupted");
    // The user stays: the claim is pending and the same owner can finish it.
    expect((await h.repos.localUsers.list()).map((user) => user.username)).toEqual(["alice"]);
    await expect(
      h.service.complete({ ...LOCAL_INPUT, password: "not the same" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await h.service.complete(LOCAL_INPUT);
    expect((await h.service.status()).required).toBe(false);
  });

  it("refuses a provider owner on a deployment that serves a folder", async () => {
    const h = await localHarness();
    await expect(h.service.complete(PROVIDER_INPUT)).rejects.toMatchObject({
      kind: "bad_request",
      message: "this deployment sets up its local folder",
    });
    expect(h.authService.loginCandidate).not.toHaveBeenCalled();
  });

  it("refuses while the folder's row is missing", async () => {
    const h = await localHarness({ pinned: false });
    await expect(h.service.complete(LOCAL_INPUT)).rejects.toMatchObject({
      kind: "bad_request",
      message: "this deployment serves no local folder",
    });
    expect(await h.repos.localUsers.list()).toEqual([]);
  });
});
