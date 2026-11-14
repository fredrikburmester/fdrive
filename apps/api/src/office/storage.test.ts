import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createLocalModule, type LocalUserStatus } from "@fdrive/local";
import { afterEach, expect, it, vi } from "vitest";
import { createPinnedStorageFactory } from "../auth/storage-factory.ts";
import { memoryProviderService } from "../providers/test-fixtures/index.ts";
import { createOfficeStorageFactory } from "./storage.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Alice's local login over a temporary folder holding `/a.docx`. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fdrive-office-storage-"));
  roots.push(root);
  await mkdir(join(root, "alice"));
  await writeFile(join(root, "alice", "a.docx"), "hello");
  let status: LocalUserStatus = "active";
  const module = createLocalModule({
    root,
    indexRoot: "files",
    users: {
      verify: async () => ({ result: "invalid" }),
      status: async () => status,
      shared: async () => [],
    },
  });
  const repos = createMemoryRepos();
  const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
  const account = await repos.accounts.create({ displayName: "alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const providers = memoryProviderService(repos, { modules: { local: module } });
  const factory = createOfficeStorageFactory({
    pinned: createPinnedStorageFactory({ providers, fetch: globalThis.fetch }),
  });
  return {
    repos,
    provider,
    identity,
    providers,
    factory,
    disable: () => {
      status = "disabled";
    },
  };
}

it("resolves the identity once and performs storage calls without database callbacks", async () => {
  const h = await fixture();
  const forIdentity = vi.spyOn(h.providers, "forIdentity");
  const storage = await h.factory(h.identity.id, h.provider.id);
  expect(forIdentity).toHaveBeenCalledExactlyOnceWith(h.identity.id);
  forIdentity.mockClear();
  expect((await storage.statFile("/a.docx")).size).toBe(5);
  await storage.upload("/a.docx", new TextEncoder().encode("saved"), { overwrite: true });
  expect(await new Response((await storage.download("/a.docx")).body).text()).toBe("saved");
  expect(forIdentity).not.toHaveBeenCalled();
});

it("fails closed with a 401 on a missing identity, a foreign or disabled provider, or a disabled user", async () => {
  const h = await fixture();
  await expect(
    h.factory("00000000-0000-0000-0000-000000000000", h.provider.id),
  ).rejects.toMatchObject({ status: 401 });
  await expect(h.factory(h.identity.id, "foreign")).rejects.toMatchObject({ status: 401 });
  h.disable();
  await expect(h.factory(h.identity.id, h.provider.id)).rejects.toMatchObject({ status: 401 });
  await h.repos.providers.update(h.provider.id, { enabled: false });
  await expect(h.factory(h.identity.id, h.provider.id)).rejects.toMatchObject({ status: 401 });
});
