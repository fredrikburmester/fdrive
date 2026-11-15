import type { SeedUser } from "@fdrive/testkit";

/** `storage.spec.ts`'s own user, whose identical files it moves to Trash. */
export const STORAGE_USERS: readonly SeedUser[] = [
  { username: "storage_dupes", password: "storage-dupes-test-password" },
];

/** Two identical copies of one file, indexed, and one file unlike them. */
export const STORAGE_FILES = {
  storage_dupes: {
    "/Holiday/beach.txt": "the same holiday notes",
    "/Backup/beach.txt": "the same holiday notes",
    "/notes.txt": "something else",
  },
};
