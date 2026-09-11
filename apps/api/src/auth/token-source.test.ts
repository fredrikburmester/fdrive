import type { Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, sftpgoModule } from "@fdrive/sftpgo";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors";
import { memoryProviderService } from "../providers/test-fixtures/index.ts";
import { parseMasterKey, seal } from "./crypto";
import { createTokenSource, parseStoredCredential } from "./token-source";

const MASTER = parseMasterKey(Buffer.alloc(32, 3).toString("base64"));
const USERNAME = "alice";
const PASSWORD = "correct-horse";
const BASE_URL = "http://sftpgo.fake";

function createClock(startMs: number) {
  let now = startMs;
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

async function seedIdentity(repos: Repos, master = MASTER): Promise<string> {
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: BASE_URL });
  const account = await repos.accounts.create({ displayName: USERNAME });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: USERNAME,
  });
  const ciphertext = seal(
    master,
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
  let identityId: string;

  function build(fetchImpl: typeof globalThis.fetch = server.fetch, master = MASTER) {
    const providers = memoryProviderService(repos, { fetch: fetchImpl, clock: clockCtl.clock });
    return createTokenSource({ repos, providers, master, clock: clockCtl.clock, fetch: fetchImpl });
  }

  beforeEach(async () => {
    repos = createMemoryRepos();
    clockCtl = createClock(Date.parse("2026-01-01T00:00:00.000Z"));
    server = buildFakeServer(20 * 60 * 1000, clockCtl.clock);
    identityId = await seedIdentity(repos);
  });

  it("coalesces concurrent token misses", async () => {
    const source = build();
    const tokens = await Promise.all(Array.from({ length: 20 }, () => source.get(identityId)));
    expect(new Set(tokens).size).toBe(1);
    expect(server.state.tokens.size).toBe(1);
  });

  it.each(["invalidate", "prime"] as const)(
    "%s supersedes a pending mint without stale writes",
    async (operation) => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let calls = 0;
      const source = build(async (input, init) => {
        const response = await server.fetch(input, init);
        if (++calls === 1) {
          entered();
          await gate;
        }
        return response;
      });
      const old = source.get(identityId);
      await started;
      if (operation === "prime")
        await source.prime(identityId, {
          token: "fresh",
          expiresAt: new Date(clockCtl.clock().getTime() + 3600000),
        });
      else await source.invalidate(identityId);
      const fresh = await source.get(identityId);
      release();
      expect(await old).toBe(fresh);
      expect(await source.get(identityId)).toBe(fresh);
      expect(await build().get(identityId)).toBe(fresh);
      expect(calls).toBe(operation === "prime" ? 1 : 2);
    },
  );

  it("serializes invalidation after an already-started database write", async () => {
    const original = repos.credentials.setCachedToken.bind(repos.credentials);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(repos.credentials, "setCachedToken").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      await original(...args);
    });
    const source = build();
    const old = source.get(identityId);
    await started;
    const invalidation = source.invalidate(identityId);
    const freshPending = source.get(identityId);
    release();
    await invalidation;
    const fresh = await freshPending;
    expect(await old).toBe(fresh);
    expect(await build().get(identityId)).toBe(fresh);
    expect(server.state.tokens.size).toBe(2);
  });

  it("does not retain a failed shared mint", async () => {
    const fetcher = vi.fn(server.fetch).mockRejectedValueOnce(new Error("offline"));
    const source = build(fetcher);
    const failed = await Promise.allSettled([source.get(identityId), source.get(identityId)]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await source.get(identityId)).toEqual(expect.any(String));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("mints a token on first use and stores it sealed in the database", async () => {
    const tokenSource = build();

    const token = await tokenSource.get(identityId);

    expect(token).toEqual(expect.any(String));
    expect(server.state.tokens.size).toBe(1);
    const credential = await repos.credentials.get(identityId);
    expect(credential?.cachedToken).toEqual(expect.any(String));
    expect(credential?.cachedToken).not.toBe(token);
    expect(credential?.cachedTokenExpiresAt).toBeInstanceOf(Date);
  });

  it("reuses the in-process cache while more than the refresh margin remains", async () => {
    const tokenSource = build();
    const first = await tokenSource.get(identityId);
    clockCtl.advance(10 * 60 * 1000);
    const second = await tokenSource.get(identityId);
    expect(second).toBe(first);
    expect(server.state.tokens.size).toBe(1);
  });

  it("re-mints once the cached token is within the refresh margin", async () => {
    const tokenSource = build();
    const first = await tokenSource.get(identityId);
    clockCtl.advance(19 * 60 * 1000);
    const second = await tokenSource.get(identityId);
    expect(second).not.toBe(first);
    expect(server.state.tokens.size).toBe(2);
  });

  it("reads a still-fresh token from the database when the in-process cache is empty", async () => {
    const first = build();
    const minted = await first.get(identityId);
    const second = build();
    const reused = await second.get(identityId);
    expect(reused).toBe(minted);
    expect(server.state.tokens.size).toBe(1);
  });

  it("invalidate forgets both the in-process cache and the database record", async () => {
    const tokenSource = build();
    const first = await tokenSource.get(identityId);
    await tokenSource.invalidate(identityId);
    expect((await repos.credentials.get(identityId))?.cachedToken).toBeNull();
    const second = await tokenSource.get(identityId);
    expect(second).not.toBe(first);
    expect(server.state.tokens.size).toBe(2);
  });

  it("builds a session whose token, credential and invalidation reach the same source", async () => {
    const tokenSource = build();
    const session = tokenSource.sessionFor(identityId, USERNAME);
    expect(session.externalUsername).toBe(USERNAME);
    const token = await session.getToken();
    expect(token).toEqual(expect.any(String));
    expect(await session.getCredential()).toEqual({ password: PASSWORD });
    await session.invalidateToken();
    expect((await repos.credentials.get(identityId))?.cachedToken).toBeNull();
    expect(await session.getToken()).not.toBe(token);
  });

  it("returns null tokens for a provider module that does not mint", async () => {
    const resolved = await memoryProviderService(repos, { fetch: server.fetch }).forIdentity(
      identityId,
    );
    const { mint: _mint, ...tokenless } = sftpgoModule;
    const tokenSource = createTokenSource({
      repos,
      providers: { forIdentity: async () => ({ ...resolved, module: tokenless }) },
      master: MASTER,
      clock: clockCtl.clock,
      fetch: server.fetch,
    });
    expect(await tokenSource.get(identityId)).toBeNull();
    expect(await tokenSource.sessionFor(identityId, USERNAME).getToken()).toBeNull();
    expect(server.state.tokens.size).toBe(0);
  });

  it("throws reauth_required when the stored password is rejected by SFTPGo", async () => {
    const ciphertext = seal(
      MASTER,
      new TextEncoder().encode(JSON.stringify({ password: "wrong" })),
      identityId,
    );
    await repos.credentials.put({ identityId, ciphertext, keyId: "master-v1" });
    const tokenSource = build();
    await expect(tokenSource.get(identityId)).rejects.toMatchObject({ kind: "reauth_required" });
  });

  it("throws reauth_required when the identity no longer exists", async () => {
    const tokenSource = build();
    await expect(tokenSource.get("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      kind: "reauth_required",
    });
  });

  it("throws reauth_required when there is no stored credential", async () => {
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: BASE_URL });
    const account = await repos.accounts.create({ displayName: "bob" });
    const bob = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "bob",
    });
    const tokenSource = build();
    await expect(tokenSource.get(bob.id)).rejects.toMatchObject({ kind: "reauth_required" });
    await expect(tokenSource.credential(bob.id)).rejects.toMatchObject({
      kind: "reauth_required",
    });
  });

  it("throws upstream_unavailable when the identity's provider is disabled", async () => {
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: BASE_URL });
    await repos.providers.update(provider.id, { enabled: false });
    const tokenSource = build();
    await expect(tokenSource.get(identityId)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
  });

  it("maps a network failure while minting to upstream_unavailable", async () => {
    const failing: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const tokenSource = build(failing);
    await expect(tokenSource.get(identityId)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
  });

  it("maps a server error while minting to upstream_unavailable", async () => {
    const failing: typeof globalThis.fetch = async () => new Response("boom", { status: 500 });
    const tokenSource = build(failing);
    await expect(tokenSource.get(identityId)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
  });

  it("propagates an ApiHttpError instance for reauth_required", async () => {
    const ciphertext = seal(
      MASTER,
      new TextEncoder().encode(JSON.stringify({ password: "wrong" })),
      identityId,
    );
    await repos.credentials.put({ identityId, ciphertext, keyId: "master-v1" });
    const tokenSource = build();
    await expect(tokenSource.get(identityId)).rejects.toBeInstanceOf(ApiHttpError);
  });

  it("throws reauth_required (not a raw CryptoError) when the stored password was sealed under a different master key", async () => {
    const other = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
    const tokenSource = build(server.fetch, other);
    await expect(tokenSource.get(identityId)).rejects.toMatchObject({ kind: "reauth_required" });
    await expect(tokenSource.credential(identityId)).rejects.toMatchObject({
      kind: "reauth_required",
    });
  });

  it("throws reauth_required when a fresh DB-cached token was sealed under a different master key", async () => {
    await build().get(identityId);
    const other = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
    const tokenSource = build(server.fetch, other);
    await expect(tokenSource.get(identityId)).rejects.toMatchObject({ kind: "reauth_required" });
  });

  it("prime seals and stores a caller-supplied token without minting a new one", async () => {
    const tokenSource = build();
    const expiresAt = new Date(clockCtl.clock().getTime() + 10 * 60 * 1000);
    await tokenSource.prime(identityId, { token: "primed", expiresAt });
    expect(await tokenSource.get(identityId)).toBe("primed");
    expect(server.state.tokens.size).toBe(0);
    const credential = await repos.credentials.get(identityId);
    expect(credential?.cachedToken).toEqual(expect.any(String));
    expect(credential?.cachedTokenExpiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it("parseStoredCredential tolerates malformed stored blobs", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    expect(parseStoredCredential(encode("not json"))).toEqual({});
    expect(parseStoredCredential(encode("[1]"))).toEqual({});
    expect(parseStoredCredential(encode('{"a":"b","n":1}'))).toEqual({ a: "b" });
  });

  it("resolves the provider before touching credentials on a cache hit", async () => {
    const tokenSource = build();
    await tokenSource.get(identityId);
    const get = vi.spyOn(repos.identities, "get").mockResolvedValue(null);
    await expect(tokenSource.get(identityId)).rejects.toMatchObject({ kind: "reauth_required" });
    get.mockRestore();
  });
});
