import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, sftpgoModule } from "@fdrive/sftpgo";
import { describe, expect, it, vi } from "vitest";
import { memoryProviderService } from "../providers/test-fixtures/index.ts";
import { seal } from "./crypto.js";
import { createTokenSource } from "./token-source.js";

/**
 * Server A holds the identity's real account; server B is a different
 * SFTPGo the deployment later points at. "Switching" disables A and adds
 * B: the stored credential is bound to A's row and must never be sent to
 * B, and once A is disabled nothing is sent anywhere.
 */
async function fixture() {
  const repos = createMemoryRepos();
  const master = Buffer.alloc(32, 2);
  const clock = () => new Date("2026-01-01T00:00:00Z");
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://a.test" });
  const account = await repos.accounts.create({ displayName: "Alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  await repos.credentials.put({
    identityId: identity.id,
    keyId: "master-v1",
    ciphertext: seal(
      master,
      new TextEncoder().encode(JSON.stringify({ password: "a-password" })),
      identity.id,
    ),
  });
  const a = createFakeSftpgoServer({
    users: [{ username: "alice", password: "a-password", permissions: { "/": ["*"] } }],
    now: clock,
  });
  const b = createFakeSftpgoServer({
    users: [{ username: "alice", password: "b-password", permissions: { "/": ["*"] } }],
    now: clock,
  });
  const requests: { host: string; authenticated: boolean }[] = [];
  let beforeRequest: (() => Promise<void>) | null = null;
  const fetchImpl: typeof globalThis.fetch = async (url, init) => {
    const host = new URL(String(url)).host;
    requests.push({ host, authenticated: new Headers(init?.headers).has("authorization") });
    await beforeRequest?.();
    return (host === "a.test" ? a : b).fetch(url, init);
  };
  const providers = memoryProviderService(repos, { fetch: fetchImpl, clock });
  const deps = { repos, providers, master, clock, fetch: fetchImpl };
  return {
    ...deps,
    deps,
    identity,
    provider,
    requests,
    source: createTokenSource(deps),
    async switchToB() {
      await repos.providers.update(provider.id, { enabled: false });
      await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://b.test" });
    },
    intercept(fn: () => Promise<void>) {
      beforeRequest = fn;
    },
  };
}
describe("cached token provider binding", () => {
  it("validates provider before process-cache or DB-cache reads and decryption", async () => {
    const h = await fixture();
    await h.source.get(h.identity.id);
    const second = createTokenSource(h.deps);
    await h.switchToB();
    const get = vi.spyOn(h.repos.credentials, "get");
    for (const source of [h.source, second])
      await expect(source.get(h.identity.id)).rejects.toMatchObject({
        kind: "upstream_unavailable",
      });
    await expect(h.source.credential(h.identity.id)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    expect(get).not.toHaveBeenCalled();
    expect(h.requests.map((call) => call.host)).toEqual(["a.test"]);
  });
  it("keeps an in-flight mint on its captured provider when configuration changes", async () => {
    const h = await fixture();
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.intercept(async () => {
      ready();
      await blocked;
    });
    const mint = h.source.get(h.identity.id);
    await started;
    await h.switchToB();
    release();
    expect(await mint).toEqual(expect.any(String));
    await expect(h.source.get(h.identity.id)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    expect(h.requests).toEqual([{ host: "a.test", authenticated: true }]);
  });
  it("revalidates before a 401 retry and never sends credentials to the new server", async () => {
    const h = await fixture();
    await h.source.prime(h.identity.id, {
      token: "a-token",
      expiresAt: new Date(h.clock().getTime() + 600000),
    });
    const session = h.source.sessionFor(h.identity.id, "alice");
    const storage = sftpgoModule.createStorage(
      { id: h.provider.id, baseUrl: h.provider.baseUrl, config: {} },
      session,
      {
        fetch: async (url, init) => {
          // The first authenticated call is the storage operation itself;
          // configuration changes while it is in flight and it fails 401.
          await h.switchToB();
          h.requests.push({
            host: new URL(String(url)).host,
            authenticated: new Headers(init?.headers).has("authorization"),
          });
          return new Response("expired", { status: 401 });
        },
      },
    );
    await expect(storage.list("/")).rejects.toMatchObject({ kind: "upstream_unavailable" });
    expect(h.requests).toEqual([{ host: "a.test", authenticated: true }]);
  });
  it("does not let a primed token bypass identity validation", async () => {
    const h = await fixture();
    await h.source.prime(h.identity.id, {
      token: "a-token",
      expiresAt: new Date(h.clock().getTime() + 600000),
    });
    vi.spyOn(h.repos.identities, "get").mockResolvedValue(null);
    await expect(h.source.get(h.identity.id)).rejects.toMatchObject({ kind: "reauth_required" });
    expect(h.requests).toEqual([]);
  });
});
