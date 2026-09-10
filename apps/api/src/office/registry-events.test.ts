import { createMemoryOfficeFileRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { expect, it, vi } from "vitest";
import { createMetadataService } from "../metadata/service.js";
import { createInMemoryMountMappingStore } from "../scoping/mount-mapping-store.ts";
import { createInMemoryScopeOverrideStore } from "../scoping/override-store.ts";
import { createScopeResolver } from "../scoping/resolver.ts";
import { fakeIndexerDirectory, fakeStorageProvider } from "../scoping/test-fixtures/index.ts";
import { applyOfficeStorageEvent, withOfficeMetadata } from "./registry-events.ts";

const now = new Date("2026-09-06T00:00:00Z");

/** Builds a real `ScopeResolver.configuredMappings` (no overrides, no index roots) over the repos' provider rows. */
function configuredMappingsFrom(repos: ReturnType<typeof createMemoryRepos>) {
  return createScopeResolver({
    providers: repos.providers,
    overrides: createInMemoryScopeOverrideStore(),
    mountMappings: createInMemoryMountMappingStore(),
    indexRoots: [],
    indexer: fakeIndexerDirectory(new Map()),
    storageForIdentity: async () => fakeStorageProvider(),
    clock: () => now,
  }).configuredMappings;
}

it("maps external move/delete once and ignores content events", async () => {
  const files = createMemoryOfficeFileRepo();
  const providerId = "123e4567-e89b-42d3-a456-426614174000";
  const file = await files.ensure({ providerId, rootName: "sftpgo", path: "alice/a.docx" });
  const event = {
    kind: "moved" as const,
    root: "sftpgo",
    path: "alice/a.docx",
    target_path: "alice/b.docx",
    at: now.toISOString(),
  };
  await applyOfficeStorageEvent(files, providerId, event);
  expect((await files.get(file.id))?.path).toBe("alice/b.docx");
  await applyOfficeStorageEvent(files, providerId, { ...event, target_path: null });
  await applyOfficeStorageEvent(files, providerId, { ...event, kind: "changed" });
  await applyOfficeStorageEvent(files, providerId, {
    ...event,
    kind: "deleted",
    path: "alice/b.docx",
  });
  expect(await files.get(file.id)).toBeNull();
});
it("wraps fs metadata hooks without duplicate indexer mapping", async () => {
  const repos = createMemoryRepos();
  const files = createMemoryOfficeFileRepo();
  const metadata = createMetadataService(repos);
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo" });
  const account = await repos.accounts.create({ displayName: null });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const wrapped = withOfficeMetadata(
    metadata,
    files,
    repos.identities,
    configuredMappingsFrom(repos),
    () => now,
  );
  const file = await files.ensure({
    providerId: provider.id,
    rootName: "sftpgo",
    path: "alice/a.docx",
  });
  await wrapped.onMoved(identity.id, "/a.docx", "/b.docx", false);
  expect((await files.get(file.id))?.path).toBe("alice/b.docx");
  await wrapped.onDeleted(identity.id, "/b.docx", false);
  expect(await files.get(file.id)).toBeNull();
  await wrapped.onMoved("missing", "/x", "/y", false);
  await wrapped.onDeleted("missing", "/x", false);
  await repos.providers.update(provider.id, { enabled: false });
  await wrapped.onDeleted(identity.id, "/x", false);
});
it("passes onTrashed through unchanged: office registrations are untouched, recents are dropped", async () => {
  const repos = createMemoryRepos();
  const files = createMemoryOfficeFileRepo();
  const metadata = createMetadataService(repos);
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo" });
  const account = await repos.accounts.create({ displayName: null });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const wrapped = withOfficeMetadata(
    metadata,
    files,
    repos.identities,
    configuredMappingsFrom(repos),
    () => now,
  );
  expect(wrapped.onTrashed).toBe(metadata.onTrashed);
  const file = await files.ensure({
    providerId: provider.id,
    rootName: "sftpgo",
    path: "alice/a.docx",
  });
  await repos.recents.touch(identity.id, "/a.docx");
  await wrapped.onTrashed(identity.id, "/a.docx", false);
  expect(await files.get(file.id)).not.toBeNull();
  expect(await metadata.listRecents(identity.id)).toEqual([]);
});

it("tombstones an old mapping if the configured root changes during move resolution", async () => {
  const repos = createMemoryRepos();
  const files = createMemoryOfficeFileRepo();
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo" });
  const account = await repos.accounts.create({ displayName: null });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const file = await files.ensure({
    providerId: provider.id,
    rootName: "sftpgo",
    path: "alice/a.docx",
  });
  let calls = 0;
  const get = repos.providers.get.bind(repos.providers);
  vi.spyOn(repos.providers, "get").mockImplementation(async (id) => {
    const row = await get(id);
    return row === null
      ? null
      : {
          ...row,
          config: { homeTemplate: ++calls === 1 ? "sftpgo:/{username}" : "other:/{username}" },
        };
  });
  await withOfficeMetadata(
    createMetadataService(repos),
    files,
    repos.identities,
    configuredMappingsFrom(repos),
    () => now,
  ).onMoved(identity.id, "/a.docx", "/b.docx", false);
  expect(await files.get(file.id)).toBeNull();
});

it("tombstones the source when the move target becomes unmapped", async () => {
  const repos = createMemoryRepos();
  const files = createMemoryOfficeFileRepo();
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo" });
  const account = await repos.accounts.create({ displayName: null });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const file = await files.ensure({
    providerId: provider.id,
    rootName: "sftpgo",
    path: "alice/a.docx",
  });
  const get = repos.providers.get.bind(repos.providers);
  vi.spyOn(repos.providers, "get")
    .mockImplementationOnce(get)
    .mockImplementation(async (id) => {
      const row = await get(id);
      return row === null ? null : { ...row, enabled: false };
    });
  await withOfficeMetadata(
    createMetadataService(repos),
    files,
    repos.identities,
    configuredMappingsFrom(repos),
    () => now,
  ).onMoved(identity.id, "/a.docx", "/elsewhere.docx", false);
  expect(await files.get(file.id)).toBeNull();
});
