import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import {
  createInMemoryMountMappingStore,
  createSettingsMountMappingStore,
  MOUNT_MAPPINGS_SETTINGS_KEY,
  validateMountMappings,
} from "./mount-mapping-store.ts";
import { ScopeOverrideValidationError } from "./validate-overrides.ts";

const shared = { virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" };
const sample = [shared];

describe.each([
  [
    "createSettingsMountMappingStore",
    () => createSettingsMountMappingStore(createMemoryRepos().settings),
  ],
  ["createInMemoryMountMappingStore", () => createInMemoryMountMappingStore()],
])("%s", (_name, build) => {
  it("starts empty, stores a list, and replaces it wholesale", async () => {
    const store = build();
    expect(await store.get()).toEqual([]);
    await store.set(sample);
    expect(await store.get()).toEqual(sample);
    await store.set([]);
    expect(await store.get()).toEqual([]);
  });
});

it("stores a versioned record under one settings key", async () => {
  const repos = createMemoryRepos();
  await createSettingsMountMappingStore(repos.settings).set(sample);
  expect(await repos.settings.get(MOUNT_MAPPINGS_SETTINGS_KEY)).toEqual({
    version: 1,
    mappings: sample,
  });
});

describe("validateMountMappings", () => {
  function reasonOf(run: () => void): string {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeOverrideValidationError);
      return (error as ScopeOverrideValidationError).reason;
    }
    return "none";
  }

  it("accepts a well-formed unique list on known roots", () => {
    expect(() => validateMountMappings(sample, { knownRoots: new Set(["sftpgo"]) })).not.toThrow();
  });

  it("rejects the root path, unknown roots, duplicates, and too many", () => {
    expect(reasonOf(() => validateMountMappings([{ ...shared, virtualPath: "/" }]))).toBe(
      "invalid_mapping",
    );
    expect(reasonOf(() => validateMountMappings(sample, { knownRoots: new Set(["x"]) }))).toBe(
      "unknown_root",
    );
    expect(reasonOf(() => validateMountMappings([...sample, ...sample]))).toBe(
      "duplicate_virtual_prefix",
    );
    const many = Array.from({ length: 65 }, (_, i) => ({ ...shared, virtualPath: `/m${i}` }));
    expect(reasonOf(() => validateMountMappings(many))).toBe("too_many");
  });
});
