import type { SeedGrant, SeedUser } from "@fdrive/testkit";

/** Shares a folder with `PEOPLE_GUEST` through the UI in `share-with-people.spec.ts`. */
export const PEOPLE_OWNER = { username: "people_owner", password: "people-owner-test-password" };
/** Starts with nothing shared; finds the owner's folder under Shared with me. */
export const PEOPLE_GUEST = { username: "people_guest", password: "people-guest-test-password" };
/** Owns `/Handbook`, which `READ_ONLY_GUEST` may only view (`permissions.spec.ts`). */
export const READ_ONLY_OWNER = { username: "handbook_owner", password: "handbook-owner-password" };
export const READ_ONLY_GUEST = {
  username: "handbook_reader",
  password: "handbook-reader-password",
};
/** Changes its own password under Account in `account-password.spec.ts`. */
export const PASSWORD_USER = { username: "password_user", password: "password-user-test-password" };

/** The folder `PEOPLE_OWNER` shares, with one file in it. */
export const PEOPLE_FOLDER = "Team plans";
export const PEOPLE_FILE = "roadmap.txt";

/**
 * Dedicated users for the specs about local accounts and sharing between
 * them, so their grants and password changes never touch alice or bob,
 * whose files and search results other specs rely on.
 */
export const PEOPLE_USERS: readonly SeedUser[] = [
  PEOPLE_OWNER,
  PEOPLE_GUEST,
  READ_ONLY_OWNER,
  READ_ONLY_GUEST,
  PASSWORD_USER,
];

export const PEOPLE_FILES = {
  [PEOPLE_OWNER.username]: { [`/${PEOPLE_FOLDER}/${PEOPLE_FILE}`]: "Ship the local folder.\n" },
  [PEOPLE_GUEST.username]: { "/guest-notes.txt": "The guest's own notes.\n" },
  [READ_ONLY_OWNER.username]: { "/Handbook/policy.txt": "Read this, change nothing.\n" },
  [READ_ONLY_GUEST.username]: { "/reader-notes.txt": "The reader's own notes.\n" },
};

/** The one folder shared from the start: the handbook, to view only. */
export const PEOPLE_GRANTS: readonly SeedGrant[] = [
  {
    owner: READ_ONLY_OWNER.username,
    path: "/Handbook",
    grantee: READ_ONLY_GUEST.username,
    access: "read",
  },
];
