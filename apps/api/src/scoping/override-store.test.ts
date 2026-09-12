import type { Scope } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import {
  createInMemoryScopeOverrideStore,
  createSettingsScopeOverrideStore,
  normalizeScopeOverrideRecord,
  scopeOverrideSettingsKey,
} from "./override-store.ts";

const sample: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" },
];

describe("scopeOverrideSettingsKey", () => {
  it("namespaces by identity id", () => {
    expect(scopeOverrideSettingsKey("identity-1")).toBe("identity_scope:identity-1");
  });
});

describe.each([
  [
    "createSettingsScopeOverrideStore",
    () => createSettingsScopeOverrideStore(createMemoryRepos().settings),
  ],
  ["createInMemoryScopeOverrideStore", () => createInMemoryScopeOverrideStore()],
])("%s", (_name, build) => {
  it("returns null for an identity with no override", async () => {
    const store = build();
    expect(await store.get("identity-1")).toBeNull();
  });

  it("returns the stored override after set", async () => {
    const store = build();
    await store.set("identity-1", sample, ["/archive"]);
    expect(await store.get("identity-1")).toEqual({
      version: 2,
      scopes: sample,
      unindexedPrefixes: ["/archive"],
    });
  });

  it("returns null after reset", async () => {
    const store = build();
    await store.set("identity-1", sample, []);
    await store.reset("identity-1");
    expect(await store.get("identity-1")).toBeNull();
  });

  it("keeps overrides for different identities independent", async () => {
    const store = build();
    await store.set("identity-1", sample, []);
    expect(await store.get("identity-2")).toBeNull();
  });

  it("reads an override with nothing in it as no override", async () => {
    const store = build();
    await store.set("identity-1", [], []);
    expect(await store.get("identity-1")).toBeNull();
    await store.set("identity-1", [], ["/archive"]);
    expect(await store.get("identity-1")).toEqual({
      version: 2,
      scopes: [],
      unindexedPrefixes: ["/archive"],
    });
  });
});

it("reset never writes a JSON null, which app.settings.value cannot hold", async () => {
  const repos = createMemoryRepos();
  const store = createSettingsScopeOverrideStore(repos.settings);
  await store.set("identity-1", sample, []);
  await store.reset("identity-1");
  expect(await repos.settings.get(scopeOverrideSettingsKey("identity-1"))).toEqual({
    version: 2,
    scopes: [],
    unindexedPrefixes: [],
  });
  expect(await store.get("identity-1")).toBeNull();
});

describe("version 1 records", () => {
  it("normalizes a stored version 1 record to version 2 with no unindexed prefixes", () => {
    expect(normalizeScopeOverrideRecord({ version: 1, scopes: sample })).toEqual({
      version: 2,
      scopes: sample,
      unindexedPrefixes: [],
    });
    expect(normalizeScopeOverrideRecord(null)).toBeNull();
    expect(normalizeScopeOverrideRecord({ version: 1, scopes: [] })).toBeNull();
  });

  it("reads a version 1 row written before unindexed prefixes existed", async () => {
    const repos = createMemoryRepos();
    await repos.settings.set(scopeOverrideSettingsKey("identity-1"), {
      version: 1,
      scopes: sample,
    });
    const store = createSettingsScopeOverrideStore(repos.settings);
    expect(await store.get("identity-1")).toEqual({
      version: 2,
      scopes: sample,
      unindexedPrefixes: [],
    });
  });
});

it("persists through transaction settings under the expected owner", async () => {
  const outside = createMemoryRepos().settings;
  const inside = createMemoryRepos().settings;
  const store = createSettingsScopeOverrideStore(outside, async (accountId, identityId, write) => {
    expect([accountId, identityId]).toEqual(["owner", "identity-1"]);
    await write(inside);
  });
  await expect(store.set("identity-1", sample, [])).rejects.toThrow("requires an owner");
  await store.set("identity-1", sample, [], "owner");
  expect(await outside.get(scopeOverrideSettingsKey("identity-1"))).toBeNull();
  expect(await inside.get(scopeOverrideSettingsKey("identity-1"))).toMatchObject({
    scopes: sample,
  });
  await store.reset("identity-1", "owner");
  expect(await inside.get(scopeOverrideSettingsKey("identity-1"))).toMatchObject({ scopes: [] });
});
