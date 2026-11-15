import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isStorageError, normalizePath, StorageError, splitSegments } from "@fdrive/core";
import { type DiskChangeListener, type IndexChange, underRoot } from "./changes.js";
import type { FilesFolderGuard } from "./files-marker.js";
import { isLocalUsername } from "./names.js";
import {
  closedToShares,
  createUserStorage,
  namedSharedGrants,
  type SharedGrant,
  type UserStorage,
} from "./shared.js";

export { isLocalUsername };

/** Whether a stored user may use their files right now. */
export type LocalUserStatus = "active" | "disabled" | "missing";

/**
 * The users of local storage and what they share with each other. fdrive
 * keeps them and checks their passwords; the files folder only asks whether a
 * user is still active and which folders others share with them, so it
 * never learns how any of that is stored.
 */
export interface LocalUsers {
  status(username: string): Promise<LocalUserStatus>;
  /** The folders other users share with `username`, oldest share first. */
  shared(username: string): Promise<readonly SharedGrant[]>;
}

export interface FilesFolderOptions {
  /**
   * The folder every home lives under, as `<root>/<username>`: the layout
   * SFTPGo uses, so its data folder can be adopted in place. Set by the
   * deployment, never by a form.
   */
  readonly root: string;
  readonly users: LocalUsers;
  /**
   * Hears every change fdrive makes under `root`, by its path relative to
   * `root`, the path the indexer reads it under, so it can index the change
   * at once.
   */
  readonly onIndexChange?: (change: IndexChange) => void;
  /**
   * Whether `root` is this installation's files folder. With it, every
   * storage operation is refused (`upstream_unavailable`) while the folder
   * is not, so a wrong mount is never served or written; `health` reports
   * it.
   */
  readonly guard?: FilesFolderGuard;
  /**
   * Folders in each user's files, as paths in them, that no share reaches:
   * their Trash while it is on and fdrive's own bookkeeping. A folder shared
   * from inside one, or from anywhere in fdrive's Trash layout
   * (`closedToShares`), is refused to the person it is shared with.
   */
  readonly closedFolders?: () => Promise<readonly string[]>;
}

/** Whether fdrive can use the files folder now, and what was found. */
export interface FilesFolderHealth {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * The files folder: files in a folder on fdrive's own disk, one home per
 * user, with users fdrive keeps. Every file operation is one filesystem
 * call or an atomic publish, so moves are atomic, uploads keep their
 * modification time, and zips stream.
 */
export interface FilesFolder {
  /**
   * `username`'s files: their home at `<root>/<username>`, plus
   * `/Shared with me` from what others share with them. Throws `forbidden`
   * for a name that cannot be a home folder.
   */
  storage(username: string): UserStorage;
  /**
   * Throws `forbidden` unless `username` is an active user, so a user
   * disabled after signing in stops at once, and `upstream_unavailable`
   * when the users cannot be read.
   */
  admit(username: string): Promise<void>;
  /** Whether the folder is this installation's and one fdrive can read, write and enter. */
  health(): Promise<FilesFolderHealth>;
}

function unavailable(error: unknown): StorageError {
  if (isStorageError(error)) return error;
  return new StorageError("upstream_unavailable", "local users are unavailable", { cause: error });
}

/** Checks that `root` is a folder this process can read and write. */
export async function probeRoot(root: string): Promise<FilesFolderHealth> {
  try {
    if (!(await stat(root)).isDirectory()) {
      return { ok: false, detail: "The storage root is not a folder" };
    }
    await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
    return { ok: true, detail: "The storage root is a writable folder" };
  } catch {
    return { ok: false, detail: "The storage root is missing or not writable by fdrive" };
  }
}

/**
 * Turns the absolute paths storage reports into ones relative to the files
 * folder `root`. Paths are real (links resolved), so they are compared with
 * the folder's real path, resolved once it is first needed. A change outside
 * it, or one made while it cannot be resolved, is left to the indexer's own
 * watcher and scans.
 */
export function createIndexListener(
  root: string,
  hear: (change: IndexChange) => void,
  resolve: (path: string) => Promise<string> = realpath,
): DiskChangeListener {
  let real: Promise<string> | undefined;
  function resolved(): Promise<string> {
    if (real === undefined) {
      real = resolve(root);
      // A failure is not kept: the next change tries again.
      real.catch(() => {
        real = undefined;
      });
    }
    return real;
  }
  return (change) => {
    // Every change waits on the same promise, so they reach `hear` in order.
    void resolved()
      .then((at) => {
        const mapped = underRoot(at, change);
        if (mapped !== null) hear(mapped);
      })
      .catch(() => undefined);
  };
}

export function createFilesFolder(options: FilesFolderOptions): FilesFolder {
  const { onIndexChange, guard } = options;
  const onChange =
    onIndexChange === undefined ? undefined : createIndexListener(options.root, onIndexChange);
  const ready =
    guard === undefined
      ? undefined
      : async () => {
          const verdict = await guard.verify();
          if (!verdict.ok) throw new StorageError("upstream_unavailable", verdict.reason);
        };
  const inHome = (owner: string, path: string) =>
    join(options.root, owner, ...splitSegments(normalizePath(path)));

  return {
    storage(username) {
      // Users are created with valid names only, so this guards a stored
      // login that predates a rule change, not a caller's input.
      if (!isLocalUsername(username)) {
        throw new StorageError("forbidden", "this login has no valid home folder");
      }
      return createUserStorage({
        ...(onChange === undefined ? {} : { onChange }),
        ...(ready === undefined ? {} : { ready }),
        home: join(options.root, username),
        shared: async () => {
          const grants = await options.users.shared(username);
          const closed = grants.length === 0 ? [] : ((await options.closedFolders?.()) ?? []);
          // Named before any is left out, as the API names them, so names never disagree.
          return namedSharedGrants(username, grants)
            .filter(({ grant }) => !closedToShares(grant.path, closed))
            .map(({ grant, name }) => ({
              name,
              dir: inHome(grant.owner, grant.path),
              ownerHome: join(options.root, grant.owner),
              writable: grant.writable,
            }));
        },
      });
    },

    async admit(username) {
      let status: LocalUserStatus;
      try {
        status = await options.users.status(username);
      } catch (error) {
        throw unavailable(error);
      }
      if (status !== "active") throw new StorageError("forbidden", "this user may not sign in");
    },

    async health() {
      const verdict = await guard?.verify();
      if (verdict !== undefined && !verdict.ok) return { ok: false, detail: verdict.reason };
      return probeRoot(options.root);
    },
  };
}
