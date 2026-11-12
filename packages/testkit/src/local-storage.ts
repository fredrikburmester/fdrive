import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seedFileLayout } from "./file-layout.js";
import {
  SEED_FILES,
  SEED_GRANTS,
  SEED_USERS,
  type SeedFiles,
  type SeedGrant,
  type SeedUser,
} from "./seed-data.js";

export interface StartLocalStorageOptions {
  /** The users whose homes exist; defaults to SEED_USERS. */
  readonly users?: readonly SeedUser[];
  /** Files by owner and virtual path; defaults to SEED_FILES. */
  readonly files?: SeedFiles;
  /**
   * Folders the users share with each other. Defaults to SEED_GRANTS with
   * the seed's own users, and to none with users of your own, since the
   * seed's grants name the seed's users.
   */
  readonly grants?: readonly SeedGrant[];
}

export interface LocalStorageFixture {
  /** The folder every home lives under, as `FDRIVE_STORAGE_ROOT` names it; a real path. */
  readonly root: string;
  readonly users: readonly SeedUser[];
  readonly grants: readonly SeedGrant[];
  /** Where `virtualPath` in `owner`'s files is on disk. */
  path(owner: string, virtualPath?: string): string;
  /** Removes the folder and everything in it. */
  stop(): Promise<void>;
}

/**
 * Lays out a local folder the way fdrive serves one (`FDRIVE_STORAGE_ROOT`):
 * a fresh temporary root with a home per user at `<root>/<username>` and
 * the seeded files inside. Users and grants live in the database, not on
 * disk; insert them with `insertLocalUsers`.
 */
export async function startLocalStorage(
  options: StartLocalStorageOptions = {},
): Promise<LocalStorageFixture> {
  const users = options.users ?? SEED_USERS;
  const files = options.files ?? SEED_FILES;
  const grants = options.grants ?? (options.users === undefined ? SEED_GRANTS : []);
  // A real path: on macOS the temporary folder sits behind a symlink, and a
  // folder fdrive confines homes to is compared by its real path.
  const root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-local-")));
  try {
    for (const user of users) await mkdir(join(root, user.username), { recursive: true });
    for (const file of seedFileLayout(files, { dataDir: root })) {
      await mkdir(dirname(file.containerPath), { recursive: true });
      await writeFile(file.containerPath, file.content);
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    users,
    grants,
    path: (owner, virtualPath = "/") => join(root, owner, virtualPath),
    stop: () => rm(root, { recursive: true, force: true }),
  };
}

/** The parts of `@fdrive/db`'s repos that `insertLocalUsers` writes to. */
export interface LocalUserRepos {
  readonly localUsers: {
    create(input: { username: string; passwordHash: string }): Promise<unknown>;
    update(username: string, patch: { disabled: boolean }): Promise<unknown>;
  };
  readonly localGrants: {
    put(input: {
      ownerUsername: string;
      path: string;
      granteeUsername: string;
      access: "read" | "write";
    }): Promise<unknown>;
  };
}

/** Hashes a password the way the API checks it at sign-in (`createScryptSharePasswords`). */
export interface LocalPasswordHasher {
  hash(password: string): Promise<string>;
}

export interface LocalUserSeed {
  readonly users: readonly SeedUser[];
  readonly grants?: readonly SeedGrant[];
  /** Users created disabled, as an administrator leaves them under System > Users. */
  readonly disabled?: readonly string[];
}

/**
 * Creates `seed.users` in `app.local_users` with their passwords hashed by
 * `passwords`, then `seed.grants` in `app.local_grants`: what setup and
 * System > Users would have done. Pass a `LocalStorageFixture` as `seed` to
 * insert the users and grants it was started with.
 */
export async function insertLocalUsers(
  repos: LocalUserRepos,
  seed: LocalUserSeed,
  passwords: LocalPasswordHasher,
): Promise<void> {
  const disabled = new Set(seed.disabled ?? []);
  for (const user of seed.users) {
    await repos.localUsers.create({
      username: user.username,
      passwordHash: await passwords.hash(user.password),
    });
    if (disabled.has(user.username)) {
      await repos.localUsers.update(user.username, { disabled: true });
    }
  }
  for (const grant of seed.grants ?? []) {
    await repos.localGrants.put({
      ownerUsername: grant.owner,
      path: grant.path,
      granteeUsername: grant.grantee,
      access: grant.access,
    });
  }
}
