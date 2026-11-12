import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isStorageError,
  type ProbeResult,
  type ProviderField,
  type ProviderModule,
  StorageError,
} from "@fdrive/core";
import { createLocalStorage } from "./storage-provider.js";

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
 * The users of local storage. fdrive keeps them; the module only asks
 * whether a password is right and whether a user is still active, so it
 * never learns how they are stored.
 */
export interface LocalUsers {
  verify(username: string, password: string): Promise<LocalUserCheck>;
  status(username: string): Promise<LocalUserStatus>;
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
}

export const LOCAL_CREDENTIAL_FIELDS: readonly ProviderField[] = [
  { name: "username", label: "Username", kind: "text", required: true, maxLength: 255 },
  { name: "password", label: "Password", kind: "password", required: true },
];

/**
 * A username is a folder name under the root. Starting with a letter or
 * digit keeps every home visible and clear of fdrive's own dotfiles; the
 * rest is the character set SFTPGo allows, so its users carry over.
 */
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@~-]{0,254}$/;

/** True when `username` can name a local user and their home folder. */
export function isLocalUsername(username: string): boolean {
  return USERNAME.test(username);
}

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
 * Files in a folder on fdrive's own disk, with users fdrive keeps. Every
 * file operation is one filesystem call or an atomic publish, so moves are
 * atomic, uploads keep their modification time, and zips stream.
 */
export function createLocalModule(options: CreateLocalModuleOptions): ProviderModule {
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
      index: true,
      scopeMapping: false,
    },
    // fdrive moves deleted files into the configured folder itself.
    trash: "move",
    shares: "owned",
    deploymentManaged: true,

    indexRootName: () => options.indexRoot ?? null,

    probe: () => probeRoot(options.root),

    async admit(_instance, externalUsername) {
      let status: LocalUserStatus;
      try {
        status = await options.users.status(externalUsername);
      } catch (error) {
        throw unavailable(error);
      }
      if (status !== "active") throw new StorageError("forbidden", "this user may not sign in");
    },

    async authenticate(_instance, credential, ctx) {
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

    createStorage(_instance, session) {
      // Authentication admits only valid names, so this guards a stored
      // identity that predates a rule change, not a caller's input.
      if (!isLocalUsername(session.externalUsername)) {
        throw new StorageError("forbidden", "this login has no valid home folder");
      }
      return createLocalStorage({ home: join(options.root, session.externalUsername) });
    },
  };
}
