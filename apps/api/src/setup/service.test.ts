import type { MeResponse } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import type { AuthService, LoginResult } from "../auth/service.js";
import { ApiHttpError } from "../errors.js";
import {
  memoryProviderService,
  probeFetch,
  seedSftpgoProvider,
} from "../providers/test-fixtures/index.ts";
import { createSetupService } from "./service.js";

const CAPABILITIES = {
  zip: true,
  setModifiedAt: true,
  atomicMove: true,
  trash: false,
  shares: true,
  office: true,
  index: false,
  scopeMapping: false,
};
const PROVIDER_ID = "123e4567-e89b-42d3-a456-426614174000";
const ME: MeResponse = {
  account: { id: "account-1", displayName: "alice" },
  identities: [
    {
      id: "identity-1",
      username: "alice",
      providerId: PROVIDER_ID,
      providerType: "sftpgo",
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

function harness(options: { fetch?: typeof globalThis.fetch; hasEnvUrl?: boolean } = {}) {
  const repos = createMemoryRepos();
  const fetchImpl = options.fetch ?? probeFetch();
  const providers = memoryProviderService(repos, { fetch: fetchImpl });
  const authService = buildAuthService({ sessionId: "session-1", me: ME });
  const setAdmin = vi.fn();
  const service = createSetupService({
    providers,
    authService,
    accounts: { setAdmin },
    settings: repos.settings,
    hasEnvUrl: options.hasEnvUrl ?? false,
  });
  return { repos, providers, authService, setAdmin, service, fetch: fetchImpl };
}

const COMPLETE_INPUT = {
  baseUrl: "http://sftpgo:8080",
  homeTemplate: "sftpgo:/{username}",
  username: "alice",
  password: "hunter2",
  userAgent: "vitest",
  ip: "127.0.0.1",
};

describe("createSetupService: status", () => {
  it("reports required true when no provider is configured", async () => {
    const h = harness();
    expect(await h.service.status()).toEqual({ required: true, hasEnvUrl: false });
  });

  it("reports required false and hasEnvUrl when an enabled provider exists", async () => {
    const h = harness({ hasEnvUrl: true });
    await seedSftpgoProvider(h.repos, "http://sftpgo:8080", { managedByEnv: true });
    expect(await h.service.status()).toEqual({ required: false, hasEnvUrl: true });
  });

  it("keeps setup required while a provider exists but is disabled", async () => {
    const h = harness();
    await seedSftpgoProvider(h.repos, "http://sftpgo:8080", { enabled: false });
    expect(await h.service.status()).toEqual({ required: true, hasEnvUrl: false });
  });
});

describe("createSetupService: test", () => {
  it("probes the candidate as an SFTPGo provider", async () => {
    const h = harness();
    const result = await h.service.test("http://sftpgo:8080");
    expect(result).toEqual({ ok: true, detail: "SFTPGo is reachable" });
    expect(h.fetch).toHaveBeenCalledWith(
      "http://sftpgo:8080/healthz",
      expect.objectContaining({ redirect: "error" }),
    );
  });
});

describe("createSetupService: complete", () => {
  it("creates the provider disabled, logs in against it, then enables it and marks the account admin", async () => {
    const h = harness();
    let enabledDuringLogin: boolean | undefined;
    vi.mocked(h.authService.loginCandidate).mockImplementation(async (_input, providerId) => {
      enabledDuringLogin = (await h.repos.providers.get(providerId))?.enabled;
      return { sessionId: "session-1", me: ME };
    });

    const result = await h.service.complete(COMPLETE_INPUT);

    const [provider] = await h.repos.providers.list();
    expect(provider).toMatchObject({
      type: "sftpgo",
      baseUrl: "http://sftpgo:8080",
      label: "",
      enabled: true,
      config: { homeTemplate: "sftpgo:/{username}" },
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
    expect(await h.service.status()).toEqual({ required: false, hasEnvUrl: false });
  });

  it("reuses the environment-pinned provider and sets its home template only after the login", async () => {
    const h = harness({ hasEnvUrl: true });
    const pinned = await seedSftpgoProvider(h.repos, "http://env:8080", {
      managedByEnv: true,
      enabled: false,
      homeTemplate: "old:/{username}",
    });
    let templateDuringLogin: unknown;
    vi.mocked(h.authService.loginCandidate).mockImplementation(async (_input, providerId) => {
      templateDuringLogin = (await h.repos.providers.get(providerId))?.config.homeTemplate;
      return { sessionId: "session-1", me: ME };
    });
    await h.service.complete({ ...COMPLETE_INPUT, baseUrl: "http://ignored:1" });
    expect(templateDuringLogin).toBe("old:/{username}");
    expect(await h.repos.providers.list()).toHaveLength(1);
    expect(await h.repos.providers.get(pinned.id)).toMatchObject({
      baseUrl: "http://env:8080",
      enabled: true,
      config: { homeTemplate: "sftpgo:/{username}" },
    });
    expect(h.authService.loginCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: pinned.id }),
      pinned.id,
      "setup.owner.v1",
    );
  });

  it("leaves an existing row's configuration untouched when the candidate login fails", async () => {
    const h = harness({ hasEnvUrl: true });
    const pinned = await seedSftpgoProvider(h.repos, "http://env:8080", {
      managedByEnv: true,
      enabled: false,
      homeTemplate: "old:/{username}",
    });
    vi.mocked(h.authService.loginCandidate).mockRejectedValueOnce(
      new ApiHttpError("unauthorized", "invalid username or password"),
    );
    await expect(
      h.service.complete({ ...COMPLETE_INPUT, homeTemplate: "bogus:/x" }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
    expect(await h.repos.providers.get(pinned.id)).toMatchObject({
      enabled: false,
      config: { homeTemplate: "old:/{username}" },
    });
  });

  it("passes otp through to the login flow when given", async () => {
    const h = harness();
    await h.service.complete({ ...COMPLETE_INPUT, otp: "123456" });
    expect(h.authService.loginCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { username: "alice", password: "hunter2", otp: "123456" },
      }),
      expect.any(String),
      "setup.owner.v1",
    );
  });

  it("rejects an invalid home template before probing", async () => {
    const h = harness();
    await expect(
      h.service.complete({ ...COMPLETE_INPUT, homeTemplate: "no-colon" }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(await h.repos.providers.list()).toEqual([]);
  });

  it("rejects when the candidate SFTPGo does not probe ok, creating nothing", async () => {
    const h = harness({
      fetch: probeFetch(false),
    });
    await expect(h.service.complete(COMPLETE_INPUT)).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(h.authService.loginCandidate).not.toHaveBeenCalled();
    expect(await h.repos.providers.list()).toEqual([]);
  });

  it.each(["unauthorized", "conflict"] as const)(
    "cleans a newly created candidate after %s",
    async (kind) => {
      const h = harness();
      vi.mocked(h.authService.loginCandidate).mockRejectedValueOnce(
        new ApiHttpError(kind, "candidate rejected"),
      );
      await expect(h.service.complete(COMPLETE_INPUT)).rejects.toMatchObject({
        kind,
      });
      expect(await h.repos.providers.list()).toEqual([]);
      expect(await h.service.status()).toEqual({ required: true, hasEnvUrl: false });
      expect(h.setAdmin).not.toHaveBeenCalled();
      await h.service.complete(COMPLETE_INPUT);
      expect(await h.service.status()).toEqual({ required: false, hasEnvUrl: false });
    },
  );

  it("resumes the verified owner's pending claim after restart", async () => {
    const h = harness();
    h.setAdmin.mockRejectedValueOnce(new Error("interrupted"));
    await expect(h.service.complete(COMPLETE_INPUT)).rejects.toThrow("interrupted");
    expect(h.authService.logout).toHaveBeenCalledWith("session-1");
    const restarted = createSetupService({
      providers: h.providers,
      authService: h.authService,
      accounts: { setAdmin: h.setAdmin },
      settings: h.repos.settings,
      hasEnvUrl: false,
    });
    expect((await restarted.status()).required).toBe(true);
    await restarted.complete(COMPLETE_INPUT);
    expect((await restarted.status()).required).toBe(false);
  });

  it("reports a conflict when the claim cannot be finalized by the same owner", async () => {
    const h = harness();
    vi.spyOn(h.repos.settings, "compareAndSet")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(h.service.complete(COMPLETE_INPUT)).rejects.toMatchObject({ kind: "conflict" });
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
    await seedSftpgoProvider(h.repos, COMPLETE_INPUT.baseUrl, { enabled: false });
    const results = await Promise.allSettled([
      h.service.complete(COMPLETE_INPUT),
      h.service.complete({ ...COMPLETE_INPUT, username: "bob", password: "builder" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { kind: "conflict" },
    });
    expect(h.setAdmin).toHaveBeenCalledTimes(1);
    expect(h.setAdmin).toHaveBeenCalledWith("account-1", true);
  });
});

it("preserves the setup error and resumable claim when session cleanup also fails", async () => {
  const h = harness();
  h.setAdmin.mockRejectedValueOnce(new Error("interrupted"));
  vi.mocked(h.authService.logout).mockRejectedValueOnce(new Error("database unavailable"));
  await expect(h.service.complete(COMPLETE_INPUT)).rejects.toThrow("interrupted");
  expect(h.authService.logout).toHaveBeenCalledWith("session-1");
  expect((await h.service.status()).required).toBe(true);
});
