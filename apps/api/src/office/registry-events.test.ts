import { createMemoryOfficeFileRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { expect, it, vi } from "vitest";
import { createConnectionStore } from "../connection/store.js";
import { createMetadataService } from "../metadata/service.js";
import { applyOfficeStorageEvent, withOfficeMetadata } from "./registry-events.ts";

const now = new Date("2026-09-06T00:00:00Z");
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
  const connection = createConnectionStore({
    settings: repos.settings,
    envUrl: "http://sftpgo",
    defaultHomeTemplate: "sftpgo:/{username}",
  });
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo" });
  const account = await repos.accounts.create({ displayName: null });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const wrapped = withOfficeMetadata(metadata, files, repos.identities, connection, () => now);
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
  vi.spyOn(connection, "current").mockResolvedValue(null);
  await wrapped.onDeleted(identity.id, "/x", false);
});
it("passes onTrashed through unchanged: office registrations are untouched, recents are dropped", async () => {
  const repos = createMemoryRepos();
  const files = createMemoryOfficeFileRepo();
  const metadata = createMetadataService(repos);
  const connection = createConnectionStore({
    settings: repos.settings,
    envUrl: "http://sftpgo",
    defaultHomeTemplate: "sftpgo:/{username}",
  });
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo" });
  const account = await repos.accounts.create({ displayName: null });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const wrapped = withOfficeMetadata(metadata, files, repos.identities, connection, () => now);
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
  const connection = createConnectionStore({
    settings: repos.settings,
    envUrl: "http://sftpgo",
    defaultHomeTemplate: "sftpgo:/{username}",
  });
  vi.spyOn(connection, "current").mockImplementation(async () => ({
    baseUrl: "http://sftpgo",
    source: "env",
    homeTemplate: ++calls === 1 ? "sftpgo:/{username}" : "other:/{username}",
  }));
  await withOfficeMetadata(
    createMetadataService(repos),
    files,
    repos.identities,
    connection,
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
  const connection = createConnectionStore({
    settings: repos.settings,
    envUrl: "http://sftpgo",
    defaultHomeTemplate: "sftpgo:/{username}",
  });
  vi.spyOn(connection, "current")
    .mockResolvedValueOnce({
      baseUrl: "http://sftpgo",
      source: "env",
      homeTemplate: "sftpgo:/{username}",
    })
    .mockResolvedValue(null);
  await withOfficeMetadata(
    createMetadataService(repos),
    files,
    repos.identities,
    connection,
    () => now,
  ).onMoved(identity.id, "/a.docx", "/elsewhere.docx", false);
  expect(await files.get(file.id)).toBeNull();
});
