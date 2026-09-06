import type { SeedFolder, SeedUser } from "./seed-data.js";

export interface SftpgoDumpVirtualFolder {
  readonly name: string;
  readonly virtual_path: string;
}

export interface SftpgoDumpUser {
  readonly username: string;
  readonly password: string;
  readonly status: number;
  readonly home_dir: string;
  readonly permissions: Record<string, string[]>;
  readonly virtual_folders: SftpgoDumpVirtualFolder[];
}

export interface SftpgoDumpFolder {
  readonly name: string;
  readonly mapped_path: string;
}

export interface SftpgoDump {
  readonly users: SftpgoDumpUser[];
  readonly folders: SftpgoDumpFolder[];
}

export interface BuildSftpgoDumpOptions {
  readonly dataDir: string;
}

/**
 * Builds the JSON document SFTPGo loads at startup via SFTPGO_LOADDATA_FROM.
 * Pure: given the same users, folders, and dataDir it always returns the
 * same dump. Passwords are passed through in plain text; SFTPGo hashes them
 * itself when it loads the dump.
 */
export function buildSftpgoDump(
  users: readonly SeedUser[],
  folders: readonly SeedFolder[],
  opts: BuildSftpgoDumpOptions,
): SftpgoDump {
  return {
    users: users.map((user) => ({
      username: user.username,
      password: user.password,
      status: 1,
      home_dir: `${opts.dataDir}/${user.username}`,
      permissions: user.permissions,
      virtual_folders: (user.virtualFolders ?? []).map((folder) => ({
        name: folder.name,
        virtual_path: folder.virtualPath,
      })),
    })),
    folders: folders.map((folder) => ({
      name: folder.name,
      mapped_path: `${opts.dataDir}/_folders/${folder.name}`,
    })),
  };
}
