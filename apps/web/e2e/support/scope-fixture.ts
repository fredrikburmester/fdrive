import type { SeedUser } from "@fdrive/testkit";

/**
 * A dedicated administrator whose SFTPGo account mounts the testkit's
 * "shared" folder as a virtual folder, so `account-scope.spec.ts` can map it
 * from the account page without touching alice's shared fixture (whose
 * storage state every other spec reuses).
 */
export const SCOPE_USERS: readonly SeedUser[] = [
  {
    username: "scope_admin",
    password: "scope-admin-test-password",
    permissions: { "/": ["*"] },
    virtualFolders: [{ name: "shared", virtualPath: "/shared" }],
  },
];

export const SCOPE_FILES = {
  scope_admin: { "/scope-own.txt": "Scope admin's own file" },
};

/** Where the testkit seeds the "shared" folder's content, relative to the index root. */
export const SHARED_FOLDER_INDEX_PREFIX = "_folders/shared";
