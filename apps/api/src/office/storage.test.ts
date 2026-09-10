import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, createSftpgoClient } from "@fdrive/sftpgo";
import { expect, it, vi } from "vitest";
import { KEY_ID, seal } from "../auth/crypto.js";
import { createPinnedStorageFactory } from "../auth/storage-factory.ts";
import { createTokenSource } from "../auth/token-source.js";
import { memoryProviderService } from "../providers/test-fixtures/index.ts";
import { createOfficeStorageFactory } from "./storage.ts";

async function fixture() {
  const repos = createMemoryRepos();
  const baseUrl = "http://storage.test";
  const master = Buffer.alloc(32, 5);
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl });
  const account = await repos.accounts.create({ displayName: "alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  await repos.credentials.put({
    identityId: identity.id,
    keyId: KEY_ID,
    ciphertext: seal(
      master,
      new TextEncoder().encode(JSON.stringify({ password: "test" })),
      identity.id,
    ),
  });
  const server = createFakeSftpgoServer({
    users: [{ username: "alice", password: "test", permissions: { "/": ["*"] } }],
    files: { alice: { "/a.docx": "hello" } },
  });
  const providers = memoryProviderService(repos, { fetch: server.fetch });
  const tokens = createTokenSource({
    repos,
    providers,
    master,
    clock: () => new Date(),
    fetch: server.fetch,
  });
  return { repos, provider, identity, server, providers, tokens, baseUrl };
}

it("resolves identity credentials once and performs storage calls without database callbacks", async () => {
  const h = await fixture();
  const get = vi.spyOn(h.tokens, "get");
  const forIdentity = vi.spyOn(h.providers, "forIdentity");
  const factory = createOfficeStorageFactory({
    pinned: createPinnedStorageFactory({
      providers: h.providers,
      tokenSource: h.tokens,
      fetch: h.server.fetch,
    }),
  });
  const storage = await factory(h.identity.id, h.provider.id);
  expect(get).toHaveBeenCalledExactlyOnceWith(h.identity.id);
  get.mockClear();
  forIdentity.mockClear();
  expect((await storage.statFile("/a.docx")).size).toBe(5);
  await storage.upload("/a.docx", new TextEncoder().encode("saved"));
  expect(await new Response((await storage.download("/a.docx")).body).text()).toBe("saved");
  expect(get).not.toHaveBeenCalled();
  expect(forIdentity).not.toHaveBeenCalled();
});

it("never refreshes a pinned token: a rejected token fails the call instead of re-minting", async () => {
  const h = await fixture();
  await h.tokens.prime(h.identity.id, {
    token: "bad-token",
    expiresAt: new Date(Date.now() + 600_000),
  });
  const login = vi.spyOn(
    createSftpgoClient({ baseUrl: h.baseUrl, fetch: h.server.fetch }),
    "login",
  );
  const factory = createOfficeStorageFactory({
    pinned: createPinnedStorageFactory({
      providers: h.providers,
      tokenSource: h.tokens,
      fetch: h.server.fetch,
    }),
  });
  const storage = await factory(h.identity.id, h.provider.id);
  await expect(storage.statFile("/a.docx")).rejects.toMatchObject({ kind: "unauthorized" });
  expect(login).not.toHaveBeenCalled();
  expect(h.server.state.tokens.size).toBe(0);
});

it("fails closed with a 401 on a missing identity, a foreign provider, or a disabled provider", async () => {
  const h = await fixture();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const factory = createOfficeStorageFactory({
    pinned: createPinnedStorageFactory({
      providers: h.providers,
      tokenSource: h.tokens,
      fetch,
    }),
  });
  await expect(
    factory("00000000-0000-0000-0000-000000000000", h.provider.id),
  ).rejects.toMatchObject({ status: 401 });
  await expect(factory(h.identity.id, "foreign")).rejects.toMatchObject({ status: 401 });
  await h.repos.providers.update(h.provider.id, { enabled: false });
  await expect(factory(h.identity.id, h.provider.id)).rejects.toMatchObject({ status: 401 });
  expect(fetch).not.toHaveBeenCalled();
});
