import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isStorageError,
  normalizePath,
  type ProbeResult,
  type ProviderField,
  type ProviderModule,
  StorageError,
  splitSegments,
} from "@fdrive/core";
import { type DiskChangeListener, type IndexChange, underRoot } from "./changes.js";
import type { FilesFolderGuard } from "./files-marker.js";
import { isLocalUsername } from "./names.js";
import {
  closedToShares,
  createUserStorage,
  namedSharedGrants,
  type SharedGrant,
} from "./shared.js";

export { isLocalUsername };

/**
 * What checking a local user's password comes to. `ok` carries the name as
 * stored, which a login may have typed in another case.
 */
export type LocalUserCheck =
  | { readonly result: "ok"; readonly username: string }
  | { readonly result: "invalid" | "disabled" };

/** Whether a stored user may use their files right now. */
export type LocalUserStatus = "active" | "disabled" | "missing";

/**
 * The users of local storage and what they share with each other. fdrive
 * keeps them; the module only asks whether a password is right, whether a
 * user is still active and which folders others share with them, so it
 * never learns how any of that is stored.
 */
export interface LocalUsers {
  verify(username: string, password: string): Promise<LocalUserCheck>;
  status(username: string): Promise<LocalUserStatus>;
  /** The folders other users share with `username`, oldest share first. */
  shared(username: string): Promise<readonly SharedGrant[]>;
}

export interface CreateLocalModuleOptions {
  /**
   * The folder every home lives under, as `<root>/<username>`: the layout
   * SFTPGo uses, so its data folder can be adopted in place. Set by the
   * deployment, never by a form.
   */
  readonly root: string;
  readonly users: LocalUsers;
  /**
   * The name of the index root the indexer reads `root` under, or `null`
   * when this deployment does not index it.
   */
  readonly indexRoot?: string | null;
  /**
   * Hears every change fdrive makes under `root`, by the path the indexer
   * reads it under `indexRoot`, so it can index the change at once. Only
   * set it when the indexer reads `root` itself (not a folder above or
   * below it), or the paths will not match. Never called without
   * `indexRoot`.
   */
  readonly onIndexChange?: (root: string, change: IndexChange) => void;
  /**
   * Whether `root` is this installation's files folder. With it, storage is
   * refused (`upstream_unavailable`) while the folder is not, so a wrong
   * mount is never served or written; `admit`, `authenticate` and `probe`
   * check it again as it goes stale.
   */
  readonly guard?: FilesFolderGuard;
  /**
   * Folders in each user's files, as paths in them, that no share reaches
   * for the provider row `providerId`: their Trash while it is on and
   * fdrive's own bookkeeping. A folder shared from inside one, or from
   * anywhere in fdrive's Trash layout (`closedToShares`), is refused to the
   * person it is shared with.
   */
  readonly closedFolders?: (providerId: string) => Promise<readonly string[]>;
}

export const LOCAL_CREDENTIAL_FIELDS: readonly ProviderField[] = [
  { name: "username", label: "Username", kind: "text", required: true, maxLength: 255 },
  { name: "password", label: "Password", kind: "password", required: true },
];

function unavailable(error: unknown): StorageError {
  if (isStorageError(error)) return error;
  return new StorageError("upstream_unavailable", "local users are unavailable", { cause: error });
}

/** Checks that `root` is a folder this process can read and write. */
export async function probeRoot(root: string): Promise<ProbeResult> {
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
 * Turns the absolute paths storage reports into ones under the index root
 * `name`. Paths are real (links resolved), so they are compared with the
 * root's real path, resolved once it is first needed. A change outside the
 * root, or one made while the root cannot be resolved, is left to the
 * indexer's own watcher and scans.
 */
export function createIndexListener(
  root: string,
  name: string,
  hear: (root: string, change: IndexChange) => void,
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
        if (mapped !== null) hear(name, mapped);
      })
      .catch(() => undefined);
  };
}

/**
 * Files in a folder on fdrive's own disk, with users fdrive keeps. Every
 * file operation is one filesystem call or an atomic publish, so moves are
 * atomic, uploads keep their modification time, and zips stream.
 */
export function createLocalModule(options: CreateLocalModuleOptions): ProviderModule {
  const { indexRoot, onIndexChange, guard } = options;
  const onChange =
    indexRoot === undefined || indexRoot === null || onIndexChange === undefined
      ? undefined
      : createIndexListener(options.root, indexRoot, onIndexChange);
  return {
    type: "local",
    label: "Local folder",
    configFields: [],
    credentialFields: LOCAL_CREDENTIAL_FIELDS,
    capabilities: {
      zip: true,
      setModifiedAt: true,
      atomicMove: true,
      trash: true,
      shares: true,
      office: true,
      shareWithPeople: true,
      index: true,
    },
    // fdrive moves deleted files into the configured folder itself.
    trash: "move",
    shares: "owned",
    deploymentManaged: true,

    indexRootName: () => options.indexRoot ?? null,

    async probe() {
      const verdict = await guard?.verify();
      if (verdict !== undefined && !verdict.ok) return { ok: false, detail: verdict.reason };
      return probeRoot(options.root);
    },

    async admit(_instance, externalUsername) {
      const verdict = await guard?.verify();
      if (verdict !== undefined && !verdict.ok) {
        throw new StorageError("upstream_unavailable", verdict.reason);
      }
      let status: LocalUserStatus;
      try {
        status = await options.users.status(externalUsername);
      } catch (error) {
        throw unavailable(error);
      }
      if (status !== "active") throw new StorageError("forbidden", "this user may not sign in");
    },

    async authenticate(_instance, credential, ctx) {
      // Signing in only reads the database, so it works while the folder is
      // refused, but it brings the verdict up to date for `createStorage`.
      await guard?.verify();
      const username = credential.username ?? ctx.expectedUsername;
      const password = credential.password ?? "";
      if (username === undefined || !isLocalUsername(username) || password.length === 0) {
        throw new StorageError("unauthorized", "invalid username or password");
      }
      let check: LocalUserCheck;
      try {
        check = await options.users.verify(username, password);
      } catch (error) {
        throw unavailable(error);
      }
      if (check.result === "disabled") {
        throw new StorageError("forbidden", "this user may not sign in");
      }
      if (check.result !== "ok") {
        throw new StorageError("unauthorized", "invalid username or password");
      }
      // Re-authenticating a known login typed in another case is still that login.
      if (ctx.expectedUsername !== undefined && check.username !== ctx.expectedUsername) {
        throw new StorageError("unauthorized", "credential names a different user");
      }
      return { externalUsername: check.username };
    },

    createStorage(instance, session) {
      guard?.assertUsable();
      // Authentication admits only valid names, so this guards a stored
      // identity that predates a rule change, not a caller's input.
      if (!isLocalUsername(session.externalUsername)) {
        throw new StorageError("forbidden", "this login has no valid home folder");
      }
      const username = session.externalUsername;
      const inHome = (owner: string, path: string) =>
        join(options.root, owner, ...splitSegments(normalizePath(path)));
      return createUserStorage({
        ...(onChange === undefined ? {} : { onChange }),
        home: join(options.root, username),
        shared: async () => {
          const grants = await options.users.shared(username);
          const closed =
            grants.length === 0 ? [] : ((await options.closedFolders?.(instance.id)) ?? []);
          // Named before any is left out, as the API names them, so names never disagree.
          return namedSharedGrants(username, grants)
            .filter(({ grant }) => !closedToShares(grant.path, closed))
            .map(({ grant, name }) => ({
              name,
              dir: inHome(grant.owner, grant.path),
              ownerHome: join(options.root, grant.owner),
              writable: grant.writable,
              closed: closed.map((folder) => inHome(grant.owner, folder)),
            }));
        },
      });
    },
  };
}
