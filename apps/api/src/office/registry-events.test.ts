import { createMemoryOfficeFileRepo, type Identity } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { expect, it } from "vitest";
import { seedStorageRow } from "../local/test-fixtures/index.ts";
import { createMetadataService } from "../metadata/service.js";
import { createScopeResolver } from "../scoping/resolver.ts";
import {
  applyOfficeRootEvent,
  applyOfficeStorageEvent,
  withOfficeMetadata,
} from "./registry-events.ts";

const now = new Date("2026-09-06T00:00:00Z");

/**
 * A real `ScopeResolver.configuredMappings` for the files folder's row
 * `storageId`, read under the root `rootName()` names at that moment.
 */
function configuredMappingsFrom(storageId: string, rootName: () => string = () => "files") {
  return (identity: Identity) =>
    createScopeResolver({ storageId, rootName: rootName(), indexRootNames: [] }).configuredMappings(
      identity,
    );
}

it("maps external move/delete once and ignores content events", async () => {
  const files = createMemoryOfficeFileRepo();
  const providerId = "123e4567-e89b-42d3-a456-426614174000";
  const file = await files.ensure({ providerId, rootName: "files", path: "alice/a.docx" });
  const event = {
    kind: "moved" as const,
    root: "files",
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
  const provider = await seedStorageRow(repos);
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
    configuredMappingsFrom(provider.id),
    () => now,
  );
  const file = await files.ensure({
    providerId: provider.id,
    rootName: "files",
    path: "alice/a.docx",
  });
  await wrapped.onMoved(identity.id, "/a.docx", "/b.docx", false);
  expect((await files.get(file.id))?.path).toBe("alice/b.docx");
  await wrapped.onDeleted(identity.id, "/b.docx", false);
  expect(await files.get(file.id)).toBeNull();
  await wrapped.onMoved("missing", "/x", "/y", false);
  await wrapped.onDeleted("missing", "/x", false);
});
it("passes onTrashed through unchanged: office registrations are untouched, recents are dropped", async () => {
  const repos = createMemoryRepos();
  const files = createMemoryOfficeFileRepo();
  const metadata = createMetadataService(repos);
  const provider = await seedStorageRow(repos);
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
    configuredMappingsFrom(provider.id),
    () => now,
  );
  expect(wrapped.onTrashed).toBe(metadata.onTrashed);
  const file = await files.ensure({
    providerId: provider.id,
    rootName: "files",
    path: "alice/a.docx",
  });
  await repos.recents.touch(identity.id, "/a.docx");
  await wrapped.onTrashed(identity.id, "/a.docx", false, "/.trash/a.docx");
  expect(await files.get(file.id)).not.toBeNull();
  expect(await metadata.listRecents(identity.id)).toEqual([]);
});

it("tombstones an old mapping if the configured root changes during move resolution", async () => {
  const repos = createMemoryRepos();
  const files = createMemoryOfficeFileRepo();
  const provider = await seedStorageRow(repos);
  const account = await repos.accounts.create({ displayName: null });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const file = await files.ensure({
    providerId: provider.id,
    rootName: "files",
    path: "alice/a.docx",
  });
  let calls = 0;
  await withOfficeMetadata(
    createMetadataService(repos),
    files,
    repos.identities,
    configuredMappingsFrom(provider.id, () => (++calls === 1 ? "files" : "other")),
    () => now,
  ).onMoved(identity.id, "/a.docx", "/b.docx", false);
  expect(await files.get(file.id)).toBeNull();
});

it("tombstones the source when the move target becomes unmapped", async () => {
  const repos = createMemoryRepos();
  const files = createMemoryOfficeFileRepo();
  const provider = await seedStorageRow(repos);
  const account = await repos.accounts.create({ displayName: null });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const file = await files.ensure({
    providerId: provider.id,
    rootName: "files",
    path: "alice/a.docx",
  });
  const mapped = configuredMappingsFrom(provider.id);
  let calls = 0;
  await withOfficeMetadata(
    createMetadataService(repos),
    files,
    repos.identities,
    async (login) =>
      ++calls === 1 ? mapped(login) : { available: false, reason: "invalid_configuration" },
    () => now,
  ).onMoved(identity.id, "/a.docx", "/elsewhere.docx", false);
  expect(await files.get(file.id)).toBeNull();
});

it("applies a root event only under the files folder's own root", async () => {
  const files = createMemoryOfficeFileRepo();
  const storage = { id: "123e4567-e89b-42d3-a456-426614174000", rootName: "files" };
  const file = await files.ensure({ providerId: storage.id, rootName: "files", path: "a.docx" });
  const event = {
    kind: "deleted" as const,
    root: "files",
    path: "a.docx",
    target_path: null,
    at: now.toISOString(),
  };
  await applyOfficeRootEvent(files, storage, { ...event, kind: "changed" });
  await applyOfficeRootEvent(files, storage, { ...event, root: "photos" });
  expect(await files.get(file.id)).not.toBeNull();
  await applyOfficeRootEvent(files, storage, event);
  expect(await files.get(file.id)).toBeNull();
});
