import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, createSftpgoClient, SftpgoError } from "@fdrive/sftpgo";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "../connection/store.js";
import { seal } from "./crypto.js";
import { createIdentityClientResolver } from "./provider-client.ts";
import { createTokenSource } from "./token-source.js";

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
  let connection: Connection = {
    baseUrl: provider.baseUrl,
    homeTemplate: "sftpgo:/{username}",
    source: "settings",
  };
  const requests: { host: string; authenticated: boolean }[] = [];
  let beforeRequest: (() => Promise<void>) | null = null;
  const clientForIdentity = createIdentityClientResolver({
    ...repos,
    connections: { current: async () => connection },
    clientForBaseUrl: (baseUrl) =>
      createSftpgoClient({
        baseUrl,
        fetch: async (url, init) => {
          const host = new URL(String(url)).host;
          requests.push({ host, authenticated: new Headers(init?.headers).has("authorization") });
          await beforeRequest?.();
          return (host === "a.test" ? a : b).fetch(url, init);
        },
      }),
  });
  const deps = { repos, master, clock, clientForIdentity };
  return {
    ...deps,
    deps,
    identity,
    requests,
    source: createTokenSource(deps),
    switchToB() {
      connection = { ...connection, baseUrl: "http://b.test" };
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
    h.switchToB();
    const get = vi.spyOn(h.repos.credentials, "get");
    for (const source of [h.source, second])
      await expect(source.get(h.identity.id)).rejects.toMatchObject({
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
    h.switchToB();
    release();
    expect(await mint).toEqual(expect.any(String));
    await expect(h.source.get(h.identity.id)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    expect(h.requests).toEqual([{ host: "a.test", authenticated: true }]);
  });
  it("revalidates before a401 retry and never sends credentials to the new server", async () => {
    const h = await fixture();
    await h.source.prime(h.identity.id, {
      accessToken: "a-token",
      expiresAt: new Date(h.clock().getTime() + 600000),
    });
    const operation = vi.fn(async () => {
      h.switchToB();
      throw new SftpgoError("Expired", "unauthorized", 401, null);
    });
    await expect(h.source.withToken(h.identity.id, operation)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledWith("a-token");
    expect(h.requests).toEqual([]);
  });
  it("does not let a primed token bypass identity validation", async () => {
    const h = await fixture();
    await h.source.prime(h.identity.id, {
      accessToken: "a-token",
      expiresAt: new Date(h.clock().getTime() + 600000),
    });
    vi.spyOn(h.repos.identities, "get").mockResolvedValue(null);
    await expect(h.source.get(h.identity.id)).rejects.toMatchObject({ kind: "reauth_required" });
    expect(h.requests).toEqual([]);
  });
});
