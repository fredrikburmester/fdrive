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

/** What checking a local user's password comes to. */
export type LocalUserCheck = "ok" | "invalid" | "disabled";

/**
 * The users of local storage. fdrive keeps them; the module only asks
 * whether a password is right, so it never learns how they are stored.
 */
export interface LocalUsers {
  verify(username: string, password: string): Promise<LocalUserCheck>;
}

export interface CreateLocalModuleOptions {
  /**
   * The folder every home lives under, as `<root>/<username>`: the layout
   * SFTPGo uses, so its data folder can be adopted in place. Set by the
   * deployment, never by a form.
   */
  readonly root: string;
  readonly users: LocalUsers;
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
      shares: false,
      office: false,
      index: false,
      scopeMapping: false,
    },
    // fdrive moves deleted files into the configured folder itself.
    trash: "move",
    // Owned shares arrive with the streamed share zip; see the local storage plan.
    shares: "none",

    probe: () => probeRoot(options.root),

    async authenticate(_instance, credential, ctx) {
      const username = credential.username ?? ctx.expectedUsername;
      const password = credential.password ?? "";
      if (username === undefined || !isLocalUsername(username) || password.length === 0) {
        throw new StorageError("unauthorized", "invalid username or password");
      }
      if (ctx.expectedUsername !== undefined && username !== ctx.expectedUsername) {
        throw new StorageError("unauthorized", "credential names a different user");
      }
      let check: LocalUserCheck;
      try {
        check = await options.users.verify(username, password);
      } catch (error) {
        if (isStorageError(error)) throw error;
        throw new StorageError("upstream_unavailable", "local users are unavailable", {
          cause: error,
        });
      }
      if (check === "disabled") throw new StorageError("forbidden", "this user may not sign in");
      if (check !== "ok") throw new StorageError("unauthorized", "invalid username or password");
      return { externalUsername: username };
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
