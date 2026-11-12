/**
 * Fixed seed data for the local-folder fixtures (`startLocalStorage`) and the
 * dev environment. These values are deliberately simple and stable so that
 * unit tests, integration tests, and anyone writing a new one can rely on
 * them without recomputing anything.
 */

/** A user of the local folder, with the password it signs in with. */
export interface SeedUser {
  readonly username: string;
  readonly password: string;
}

/** What a grant lets its grantee do in the shared folder. */
export type SeedGrantAccess = "read" | "write";

/** A folder one seed user shares with another, shown at `/Shared with me/<name>`. */
export interface SeedGrant {
  readonly owner: string;
  /** The folder in the owner's files, as a virtual path. */
  readonly path: string;
  readonly grantee: string;
  readonly access: SeedGrantAccess;
}

/** Files keyed by owner username, then by virtual path within that owner's home. */
export type SeedFiles = Readonly<Record<string, Readonly<Record<string, string>>>>;

export const SEED_USERS: readonly SeedUser[] = [
  { username: "alice", password: "alice-password" },
  { username: "bob", password: "bob-password" },
  { username: "carol", password: "carol-password" },
];

/**
 * bob reads alice's docs but cannot change them, and carol drops files into
 * bob's inbox: one read-only and one writable share.
 */
export const SEED_GRANTS: readonly SeedGrant[] = [
  { owner: "alice", path: "/docs", grantee: "bob", access: "read" },
  { owner: "bob", path: "/inbox", grantee: "carol", access: "write" },
];

export const SEED_FILES: SeedFiles = {
  alice: {
    "/docs/readme.md": "# Alice's docs\n\nThis is a seeded readme for integration tests.\n",
    "/docs/report.pdf": "%PDF-1.4\nseeded report bytes for testing\n",
    "/photo.jpg": "seeded jpg bytes for testing",
  },
  bob: {
    "/inbox/.keep": "",
    "/public/notes.txt": "Bob's public notes seeded for testing.\n",
  },
  carol: {
    "/own.txt": "Carol's own file seeded for testing.\n",
  },
};
