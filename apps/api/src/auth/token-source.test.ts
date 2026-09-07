import type { Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import type { SftpgoClient } from "@fdrive/sftpgo";
import { createFakeSftpgoServer, createSftpgoClient, SftpgoError } from "@fdrive/sftpgo";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiHttpError } from "../errors";
import { parseMasterKey, seal } from "./crypto";
import { createTokenSource } from "./token-source";

const MASTER = parseMasterKey(Buffer.alloc(32, 3).toString("base64"));
const USERNAME = "alice";
const PASSWORD = "correct-horse";

function createClock(startMs: number) {
  let now = startMs;
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

async function seedIdentity(repos: Repos): Promise<string> {
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo.fake" });
  const account = await repos.accounts.create({ displayName: USERNAME });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: USERNAME,
  });
  const ciphertext = seal(
    MASTER,
    new TextEncoder().encode(JSON.stringify({ password: PASSWORD })),
    identity.id,
  );
  await repos.credentials.put({ identityId: identity.id, ciphertext, keyId: "master-v1" });
  return identity.id;
}

function buildFakeServer(tokenTtlMs: number, now: () => Date) {
  return createFakeSftpgoServer({
    users: [{ username: USERNAME, password: PASSWORD, permissions: { "/": ["*"] } }],
    tokenTtlMs,
    now,
  });
}

describe("createTokenSource", () => {
  let repos: Repos;
  let clockCtl: ReturnType<typeof createClock>;
  let server: ReturnType<typeof buildFakeServer>;
  let sftpgo: SftpgoClient;
  let identityId: string;

  beforeEach(async () => {
    repos = createMemoryRepos();
    clockCtl = createClock(Date.parse("2026-01-01T00:00:00.000Z"));
    server = buildFakeServer(20 * 60 * 1000, clockCtl.clock);
    sftpgo = createSftpgoClient({ baseUrl: "http://sftpgo.fake", fetch: server.fetch });
    identityId = await seedIdentity(repos);
  });

  it("mints a token on first use and stores it sealed in the database", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    const token = await tokenSource.get(identityId);

    expect(typeof token).toBe("string");
    const credential = await repos.credentials.get(identityId);
    expect(credential?.cachedToken).not.toBeNull();
    expect(credential?.cachedTokenExpiresAt).not.toBeNull();
  });

  it("reuses the in-process cache while more than the refresh margin remains", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    const first = await tokenSource.get(identityId);
    const second = await tokenSource.get(identityId);

    expect(second).toBe(first);
  });

  it("re-mints once the cached token is within the refresh margin", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    const first = await tokenSource.get(identityId);
    clockCtl.advance(20 * 60 * 1000 - 60 * 1000); // 1 minute left: inside the 2-minute margin

    const second = await tokenSource.get(identityId);

    expect(second).not.toBe(first);
  });

  it("reads a still-fresh token from the database when the in-process cache is empty", async () => {
    const first = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });
    const mintedToken = await first.get(identityId);

    // A second token source (e.g. a second API process) sharing the same
    // repos should reuse the DB-cached token instead of minting a new one.
    const second = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });
    const reused = await second.get(identityId);

    expect(reused).toBe(mintedToken);
  });

  it("invalidate forgets both the in-process cache and the database record", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });
    await tokenSource.get(identityId);

    await tokenSource.invalidate(identityId);

    const credential = await repos.credentials.get(identityId);
    expect(credential?.cachedToken).toBeNull();
    expect(credential?.cachedTokenExpiresAt).toBeNull();
  });

  it("withToken runs fn with a valid token and returns its result", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    const result = await tokenSource.withToken(identityId, async (token) => {
      const entries = await sftpgo.user(token).list("/");
      return entries.length;
    });

    expect(result).toBe(0);
  });

  it("withToken retries exactly once after a 401, minting a fresh token", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });
    const staleToken = await tokenSource.get(identityId);
    // Simulate the token being revoked server-side without our knowledge.
    server.state.tokens.delete(staleToken);

    let attempt = 0;
    const result = await tokenSource.withToken(identityId, async (token) => {
      attempt += 1;
      return sftpgo.user(token).list("/");
    });

    expect(result).toEqual([]);
    expect(attempt).toBe(2);
  });

  it("withToken lets a non-unauthorized SftpgoError propagate without retrying", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    let attempt = 0;
    await expect(
      tokenSource.withToken(identityId, async () => {
        attempt += 1;
        throw new SftpgoError("boom", "not_found", 404, null);
      }),
    ).rejects.toThrow(SftpgoError);
    expect(attempt).toBe(1);
  });

  it("withToken lets a non-SftpgoError propagate without retrying", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    await expect(
      tokenSource.withToken(identityId, async () => {
        throw new Error("unrelated failure");
      }),
    ).rejects.toThrow("unrelated failure");
  });

  it("throws reauth_required when the stored password is rejected by SFTPGo", async () => {
    // The user's real password changed; the sealed credential is now stale.
    const existingUser = server.state.users.get(USERNAME);
    if (!existingUser) {
      throw new Error("test setup error: expected the seeded user to exist");
    }
    server.state.users.set(USERNAME, { ...existingUser, password: "a-new-password" });
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    await expect(tokenSource.get(identityId)).rejects.toMatchObject({
      kind: "reauth_required",
    });
  });

  it("throws reauth_required when the identity no longer exists", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    await expect(tokenSource.get("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      kind: "reauth_required",
    });
  });

  it("throws reauth_required when there is no stored credential", async () => {
    const provider = await repos.providers.ensure({
      type: "sftpgo",
      baseUrl: "http://sftpgo.fake",
    });
    const account = await repos.accounts.create({ displayName: "no-creds" });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "no-creds",
    });
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    await expect(tokenSource.get(identity.id)).rejects.toMatchObject({
      kind: "reauth_required",
    });
  });

  it("maps a network failure while minting to upstream_unavailable", async () => {
    const throwingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v2/user/token")) {
        throw new Error("connection refused");
      }
      return server.fetch(input, init);
    };
    const throwingClient = createSftpgoClient({
      baseUrl: "http://sftpgo.fake",
      fetch: throwingFetch,
    });
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => throwingClient,
      master: MASTER,
      clock: clockCtl.clock,
    });

    await expect(tokenSource.get(identityId)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
  });

  it("maps a server error while minting to upstream_unavailable", async () => {
    const failingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v2/user/token")) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return server.fetch(input, init);
    };
    const failingClient = createSftpgoClient({
      baseUrl: "http://sftpgo.fake",
      fetch: failingFetch,
    });
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => failingClient,
      master: MASTER,
      clock: clockCtl.clock,
    });

    await expect(tokenSource.get(identityId)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
  });

  it("propagates an ApiHttpError instance for reauth_required", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });

    await expect(tokenSource.get("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      ApiHttpError,
    );
  });

  it("throws reauth_required (not a raw CryptoError) when the stored password was sealed under a different master key", async () => {
    const rotatedMaster = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: rotatedMaster,
      clock: clockCtl.clock,
    });

    await expect(tokenSource.get(identityId)).rejects.toMatchObject({
      kind: "reauth_required",
      message: expect.stringContaining("cannot be decrypted"),
    });
  });

  it("throws reauth_required when a fresh DB-cached token was sealed under a different master key", async () => {
    const firstSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });
    await firstSource.get(identityId);

    const rotatedMaster = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
    const secondSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: rotatedMaster,
      clock: clockCtl.clock,
    });

    await expect(secondSource.get(identityId)).rejects.toMatchObject({
      kind: "reauth_required",
    });
  });

  it("prime seals and stores a caller-supplied token without minting a new one", async () => {
    const tokenSource = createTokenSource({
      repos,
      clientForIdentity: async () => sftpgo,
      master: MASTER,
      clock: clockCtl.clock,
    });
    const expiresAt = new Date(clockCtl.clock().getTime() + 20 * 60 * 1000);

    await tokenSource.prime(identityId, { accessToken: "primed-token", expiresAt });

    expect(await tokenSource.get(identityId)).toBe("primed-token");
    const credential = await repos.credentials.get(identityId);
    expect(credential?.cachedToken).not.toBeNull();
    expect(credential?.cachedTokenExpiresAt).toEqual(expiresAt);
    // No SFTPGo login happened: `prime` only seals and caches what it is given.
    expect(server.state.tokens.size).toBe(0);
  });
});
