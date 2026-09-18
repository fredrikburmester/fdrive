import type { StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import { expect, it } from "vitest";
import { missingPublishGates, publishesSafely } from "./publish-gate.js";

it("names the unmet gate behind every refused publication", () => {
  const plain = createMemoryStorage({}) as StorageProvider;
  const leased: StorageProvider = { ...plain, withWriteLease: async (action) => action(plain) };
  const optimistic: StorageProvider = { ...plain, optimisticPublish: true };
  expect(missingPublishGates(leased, false)).toEqual([]);
  expect(missingPublishGates(optimistic, true)).toEqual([]);
  // Optimistic publication without the serialization it depends on stays read-only.
  expect(missingPublishGates(optimistic, false)).toEqual(["publish_lock"]);
  expect(missingPublishGates(plain, true)).toEqual(["storage"]);
  for (const [storage, serialized] of [
    [leased, false],
    [optimistic, true],
    [optimistic, false],
    [plain, true],
  ] as const) {
    expect(publishesSafely(storage, serialized)).toBe(
      missingPublishGates(storage, serialized).length === 0,
    );
  }
});
