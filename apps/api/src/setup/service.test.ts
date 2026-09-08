import type { MeResponse } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import type { AuthService, LoginResult } from "../auth/service.js";
import type { Connection, ConnectionStore } from "../connection/store.js";
import { ApiHttpError } from "../errors.js";
import { createSetupClaimStore } from "./claim.js";
import { createSetupService } from "./service.js";

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function okProbeFetch(): typeof globalThis.fetch {
  return vi
    .fn()
    .mockResolvedValueOnce(textResponse(200, "ok"))
    .mockResolvedValueOnce(textResponse(401, "unauthorized")) as unknown as typeof globalThis.fetch;
}

const ME: MeResponse = {
  account: { id: "account-1", displayName: "alice" },
  identities: [{ id: "identity-1", username: "alice", providerType: "sftpgo", providerLabel: "x" }],
  activeIdentityId: "identity-1",
  isAdmin: false,
};

function buildConnectionStore(current: Connection | null = null): ConnectionStore {
  return {
    current: vi.fn().mockResolvedValue(current),
    update: vi.fn().mockResolvedValue({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
      source: "settings",
    }),
  };
}

function buildAuthService(loginResult: LoginResult): Pick<AuthService, "loginCandidate" | "me"> {
  return {
    loginCandidate: vi.fn().mockResolvedValue(loginResult),
    me: vi.fn().mockResolvedValue({ ...loginResult.me, isAdmin: true }),
  };
}

function buildClaims() {
  return createSetupClaimStore(createMemoryRepos().settings);
}

describe("createSetupService: status", () => {
  it("reports required true when no connection is configured", async () => {
    const service = createSetupService({
      connectionStore: buildConnectionStore(null),
      authService: buildAuthService({ sessionId: "s", me: ME }),
      accounts: { setAdmin: vi.fn() },
      claims: buildClaims(),
      fetch: okProbeFetch(),
      hasEnvUrl: false,
    });

    expect(await service.status()).toEqual({ required: true, hasEnvUrl: false });
  });

  it("reports required false and hasEnvUrl when a connection exists", async () => {
    const service = createSetupService({
      connectionStore: buildConnectionStore({
        baseUrl: "http://sftpgo:8080",
        homeTemplate: "sftpgo:/{username}",
        source: "env",
      }),
      authService: buildAuthService({ sessionId: "s", me: ME }),
      accounts: { setAdmin: vi.fn() },
      claims: buildClaims(),
      fetch: okProbeFetch(),
      hasEnvUrl: true,
    });

    expect(await service.status()).toEqual({ required: false, hasEnvUrl: true });
  });
});

describe("createSetupService: test", () => {
  it("delegates to probeConnection", async () => {
    const service = createSetupService({
      connectionStore: buildConnectionStore(null),
      authService: buildAuthService({ sessionId: "s", me: ME }),
      accounts: { setAdmin: vi.fn() },
      claims: buildClaims(),
      fetch: okProbeFetch(),
      hasEnvUrl: false,
    });

    const result = await service.test("http://sftpgo:8080");

    expect(result).toEqual({ ok: true, detail: "SFTPGo is reachable" });
  });
});

describe("createSetupService: complete", () => {
  it("stores the connection, logs in, and marks the account admin", async () => {
    const connectionStore = buildConnectionStore(null);
    const authService = buildAuthService({ sessionId: "session-1", me: ME });
    const setAdmin = vi.fn();

    const service = createSetupService({
      connectionStore,
      authService,
      accounts: { setAdmin },
      claims: buildClaims(),
      fetch: okProbeFetch(),
      hasEnvUrl: false,
    });

    const result = await service.complete({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
      username: "alice",
      password: "hunter2",
      userAgent: "vitest",
      ip: "127.0.0.1",
    });

    expect(connectionStore.update).toHaveBeenCalledWith({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
    });
    expect(authService.loginCandidate).toHaveBeenCalledWith(
      {
        username: "alice",
        password: "hunter2",
        userAgent: "vitest",
        ip: "127.0.0.1",
      },
      "http://sftpgo:8080",
    );
    expect(setAdmin).toHaveBeenCalledWith("account-1", true);
    expect(result.sessionId).toBe("session-1");
    expect(result.me.isAdmin).toBe(true);
  });

  it("passes otp through to the login flow when given", async () => {
    const authService = buildAuthService({ sessionId: "session-1", me: ME });
    const service = createSetupService({
      connectionStore: buildConnectionStore(null),
      authService,
      accounts: { setAdmin: vi.fn() },
      claims: buildClaims(),
      fetch: okProbeFetch(),
      hasEnvUrl: false,
    });

    await service.complete({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
      username: "alice",
      password: "hunter2",
      otp: "123456",
      userAgent: null,
      ip: "127.0.0.1",
    });

    expect(authService.loginCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ otp: "123456" }),
      "http://sftpgo:8080",
    );
  });

  it("rejects an invalid home template before probing", async () => {
    const fetchImpl = vi.fn();
    const service = createSetupService({
      connectionStore: buildConnectionStore(null),
      authService: buildAuthService({ sessionId: "s", me: ME }),
      accounts: { setAdmin: vi.fn() },
      claims: buildClaims(),
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      hasEnvUrl: false,
    });

    await expect(
      service.complete({
        baseUrl: "http://sftpgo:8080",
        homeTemplate: "not-a-template",
        username: "alice",
        password: "hunter2",
        userAgent: null,
        ip: "127.0.0.1",
      }),
    ).rejects.toBeInstanceOf(ApiHttpError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects when the candidate SFTPGo does not probe ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(500, "boom"));
    const service = createSetupService({
      connectionStore: buildConnectionStore(null),
      authService: buildAuthService({ sessionId: "s", me: ME }),
      accounts: { setAdmin: vi.fn() },
      claims: buildClaims(),
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      hasEnvUrl: false,
    });

    await expect(
      service.complete({
        baseUrl: "http://sftpgo:8080",
        homeTemplate: "sftpgo:/{username}",
        username: "alice",
        password: "hunter2",
        userAgent: null,
        ip: "127.0.0.1",
      }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("keeps setup required after a rejected candidate login, so the owner can retry", async () => {
    const connectionStore = buildConnectionStore(null);
    const authService: Pick<AuthService, "loginCandidate" | "me"> = {
      loginCandidate: vi.fn().mockRejectedValue(new ApiHttpError("unauthorized", "bad login")),
      me: vi.fn(),
    };
    const claims = buildClaims();
    const service = createSetupService({
      connectionStore,
      authService,
      accounts: { setAdmin: vi.fn() },
      claims,
      fetch: okProbeFetch(),
      hasEnvUrl: false,
    });

    await expect(
      service.complete({
        baseUrl: "http://sftpgo:8080",
        homeTemplate: "sftpgo:/{username}",
        username: "alice",
        password: "wrong",
        userAgent: null,
        ip: "127.0.0.1",
      }),
    ).rejects.toMatchObject({ kind: "unauthorized" });

    expect(connectionStore.update).not.toHaveBeenCalled();
    expect(await claims.current()).toBeNull();
    expect(await service.status()).toEqual({ required: true, hasEnvUrl: false });
  });

  it("allows only one owner when two verified users race to claim setup", async () => {
    const claims = buildClaims();
    const alice = createSetupService({
      connectionStore: buildConnectionStore(null),
      authService: buildAuthService({ sessionId: "alice", me: ME }),
      accounts: { setAdmin: vi.fn() },
      claims,
      fetch: okProbeFetch(),
      hasEnvUrl: false,
    });
    const bobMe: MeResponse = {
      ...ME,
      account: { id: "account-2", displayName: "bob" },
      identities: [
        { id: "identity-2", username: "bob", providerType: "sftpgo", providerLabel: "x" },
      ],
      activeIdentityId: "identity-2",
    };
    const bob = createSetupService({
      connectionStore: buildConnectionStore(null),
      authService: buildAuthService({ sessionId: "bob", me: bobMe }),
      accounts: { setAdmin: vi.fn() },
      claims,
      fetch: okProbeFetch(),
      hasEnvUrl: false,
    });
    const input = {
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
      password: "secret",
      userAgent: null,
      ip: "127.0.0.1",
    };

    const results = await Promise.allSettled([
      alice.complete({ ...input, username: "alice" }),
      bob.complete({ ...input, username: "bob" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await claims.current())?.state).toBe("complete");
  });
});
