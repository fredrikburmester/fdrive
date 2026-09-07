import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, createSftpgoClient } from "@fdrive/sftpgo";
import { expect, it, vi } from "vitest";
import { createOfficeStorageFactory } from "./storage.ts";

it("resolves identity credentials once and performs storage calls without database callbacks", async () => {
  const repos = createMemoryRepos();
  const baseUrl = "http://storage.test";
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl });
  const server = createFakeSftpgoServer({
    users: [{ username: "alice", password: "test", permissions: { "/": ["*"] } }],
    files: { alice: { "/a.docx": "hello" } },
  });
  const token = await createSftpgoClient({ baseUrl, fetch: server.fetch }).login({
    username: "alice",
    password: "test",
  });
  const current = vi.fn(async () => ({
    baseUrl,
    homeTemplate: "sftpgo:/shared",
    source: "env" as const,
  }));
  const get = vi.fn(async () => token.accessToken);
  const ensure = vi.spyOn(repos.providers, "ensure");
  const factory = createOfficeStorageFactory({
    providers: repos.providers,
    connections: { current },
    tokens: { get },
    fetch: server.fetch,
  });
  const storage = await factory("identity", provider.id);
  expect(get).toHaveBeenCalledExactlyOnceWith("identity");
  current.mockClear();
  get.mockClear();
  ensure.mockClear();
  expect((await storage.statFile("/a.docx")).size).toBe(5);
  await storage.upload("/a.docx", new TextEncoder().encode("saved"));
  expect(await new Response((await storage.download("/a.docx")).body).text()).toBe("saved");
  expect(current).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
  const badTokenFactory = createOfficeStorageFactory({
    providers: repos.providers,
    connections: { current },
    tokens: { get: async () => "bad-token" },
    fetch: server.fetch,
  });
  const badStorage = await badTokenFactory("identity", provider.id);
  await expect(badStorage.statFile("/a.docx")).rejects.toMatchObject({ kind: "unauthorized" });
});
it("fails closed on missing, foreign, or changed connection snapshots", async () => {
  const repos = createMemoryRepos();
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://storage.test" });
  const tokens = { get: vi.fn(async () => "token") };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const current = vi.fn(
    async (): Promise<{ baseUrl: string; homeTemplate: string; source: "env" } | null> => null,
  );
  const factory = createOfficeStorageFactory({
    providers: repos.providers,
    connections: { current },
    tokens,
    fetch,
  });
  await expect(factory("identity", provider.id)).rejects.toMatchObject({ status: 401 });
  current.mockResolvedValue({
    baseUrl: "http://storage.test",
    homeTemplate: "sftpgo:/shared",
    source: "env",
  });
  await expect(factory("identity", "foreign")).rejects.toMatchObject({ status: 401 });
  expect(tokens.get).not.toHaveBeenCalled();
  current
    .mockResolvedValueOnce({
      baseUrl: "http://storage.test",
      homeTemplate: "sftpgo:/shared",
      source: "env",
    })
    .mockResolvedValue(null);
  await expect(factory("identity", provider.id)).rejects.toMatchObject({ status: 401 });
  expect(fetch).not.toHaveBeenCalled();
});
