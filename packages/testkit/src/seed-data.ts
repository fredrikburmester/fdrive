/**
 * Fixed seed data shared by the SFTPGo testkit. These values are deliberately
 * simple and stable so that unit tests, the integration test, and anyone
 * writing a new integration test against the containers can rely on them
 * without recomputing anything.
 */

export interface SeedVirtualFolder {
  readonly name: string;
  readonly virtualPath: string;
}

export interface SeedUser {
  readonly username: string;
  readonly password: string;
  readonly permissions: Record<string, string[]>;
  readonly virtualFolders?: SeedVirtualFolder[];
}

export interface SeedFolder {
  readonly name: string;
}

/** The one shared folder mapped into carol's home as a virtual folder. */
export const SEED_FOLDERS: readonly SeedFolder[] = [{ name: "shared" }];

export const SEED_USERS: readonly SeedUser[] = [
  {
    username: "alice",
    password: "alice-password",
    permissions: { "/": ["*"] },
  },
  {
    username: "bob",
    password: "bob-password",
    permissions: {
      "/": ["list", "download"],
      "/inbox": ["list", "upload", "create_dirs"],
    },
  },
  {
    username: "carol",
    password: "carol-password",
    permissions: { "/": ["*"] },
    virtualFolders: [{ name: "shared", virtualPath: "/shared" }],
  },
];

/**
 * Files seeded into the container, keyed by owner username and then by
 * virtual path within that owner's home. The special key "@shared" holds the
 * content of the shared folder itself, mapped by seedFileLayout into the
 * folder's mapped path rather than any single user's home.
 */
export const SEED_FILES: Readonly<Record<string, Record<string, string>>> = {
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
  "@shared": {
    "/team.txt": "Shared team file seeded for testing.\n",
  },
};
