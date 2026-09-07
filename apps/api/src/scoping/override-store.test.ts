import type { Scope } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import {
  createInMemoryScopeOverrideStore,
  createSettingsScopeOverrideStore,
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
    await store.set("identity-1", sample);
    expect(await store.get("identity-1")).toEqual({ version: 1, scopes: sample });
  });

  it("returns null after reset", async () => {
    const store = build();
    await store.set("identity-1", sample);
    await store.reset("identity-1");
    expect(await store.get("identity-1")).toBeNull();
  });

  it("keeps overrides for different identities independent", async () => {
    const store = build();
    await store.set("identity-1", sample);
    expect(await store.get("identity-2")).toBeNull();
  });

  it("set with an empty scope list stores an empty array rather than resetting", async () => {
    const store = build();
    await store.set("identity-1", []);
    expect(await store.get("identity-1")).toEqual({ version: 1, scopes: [] });
  });
});
