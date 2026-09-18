import type { StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import { expect, it } from "vitest";
import { missingPublishGates, publishesSafely } from "./publish-gate.js";

it("qualifies every storage by lease or by fdrive's own serialization, never by neither", () => {
  const plain = createMemoryStorage({}) as StorageProvider;
  const leased: StorageProvider = { ...plain, withWriteLease: async (action) => action(plain) };
  expect(missingPublishGates(leased, false)).toEqual([]);
  expect(missingPublishGates(plain, true)).toEqual([]);
  // Publication without the serialization it depends on stays read-only.
  expect(missingPublishGates(plain, false)).toEqual(["publish_lock"]);
  for (const [storage, serialized] of [
    [leased, false],
    [plain, true],
    [plain, false],
  ] as const) {
    expect(publishesSafely(storage, serialized)).toBe(
      missingPublishGates(storage, serialized).length === 0,
    );
  }
});
