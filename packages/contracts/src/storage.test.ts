import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORAGE_NAME,
  StorageName,
  SystemStorage,
  SystemStorageUpdateRequest,
} from "./storage.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";

describe("storage contracts", () => {
  it("reads the storage's name and health", () => {
    const storage = { id: ID, name: DEFAULT_STORAGE_NAME, healthy: false, detail: "no marker" };
    expect(SystemStorage.parse(storage)).toEqual(storage);
    expect(SystemStorage.safeParse({ ...storage, id: "local" }).success).toBe(false);
    expect(SystemStorage.safeParse({ ...storage, healthy: undefined }).success).toBe(false);
  });

  it("renames only, with a trimmed and bounded name", () => {
    expect(SystemStorageUpdateRequest.parse({ name: "  Home storage  " })).toEqual({
      name: "Home storage",
    });
    for (const name of ["", " \t\n ", "x".repeat(121)]) {
      expect(SystemStorageUpdateRequest.safeParse({ name }).success).toBe(false);
    }
    expect(StorageName.parse("x".repeat(120))).toHaveLength(120);
    expect(SystemStorageUpdateRequest.safeParse({}).success).toBe(false);
    expect(SystemStorageUpdateRequest.safeParse({ name: "Home", label: "Home" }).success).toBe(
      false,
    );
  });
});
