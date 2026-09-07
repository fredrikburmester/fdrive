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

/** The name shared by the recycle-folder event action and the rule that triggers it. */
export const TRASH_EVENT_ACTION_NAME = "fdrive-move-to-trash";
export const TRASH_EVENT_RULE_NAME = "fdrive-trash";

export interface SftpgoDumpEventAction {
  readonly name: string;
  readonly type: number;
  readonly options: {
    readonly fs_config: {
      readonly type: number;
      readonly renames: { readonly key: string; readonly value: string }[];
    };
  };
}

export interface SftpgoDumpEventRule {
  readonly name: string;
  readonly status: number;
  readonly trigger: number;
  readonly conditions: {
    readonly fs_events: string[];
    readonly options: {
      readonly fs_paths: { readonly pattern: string; readonly inverse_match: boolean }[];
    };
  };
  readonly actions: {
    readonly name: string;
    readonly order: number;
    readonly relation_options: {
      readonly execute_sync: boolean;
      readonly stop_on_failure: boolean;
    };
  }[];
}

export interface SftpgoDump {
  readonly users: SftpgoDumpUser[];
  readonly folders: SftpgoDumpFolder[];
  readonly event_actions?: SftpgoDumpEventAction[];
  readonly event_rules?: SftpgoDumpEventRule[];
}

export interface BuildSftpgoDumpOptions {
  readonly dataDir: string;
  /**
   * When given, adds the Event Manager rule and action that move a
   * pre-delete file to `trash.path` (SFTPGo's recycle-folder recipe), so
   * every seeded user gets a working trash at that virtual path.
   */
  readonly trash?: { readonly path: string };
}

/**
 * Builds the recycle-folder event action and rule described in
 * `docs/workflow/P6-TRASH.md`: a pre-delete filesystem event renames the
 * deleted path to `<trashPath>/<original dir>/<original name>/<timestamp>`,
 * except for deletes already under `trashPath` (which stay permanent).
 * Verified against the real `drakkan/sftpgo:v2.7.5` container: both keys
 * load correctly from `SFTPGO_LOADDATA_FROM`, and the rule can reference the
 * action by name within the same dump.
 */
function buildTrashEventConfig(trashPath: string): {
  event_actions: SftpgoDumpEventAction[];
  event_rules: SftpgoDumpEventRule[];
} {
  return {
    event_actions: [
      {
        name: TRASH_EVENT_ACTION_NAME,
        type: 9,
        options: {
          fs_config: {
            type: 1,
            renames: [
              {
                key: "/{{.VirtualPath}}",
                value: `${trashPath}/{{.VirtualDirPath}}/{{.ObjectName}}/{{.Timestamp}}`,
              },
            ],
          },
        },
      },
    ],
    event_rules: [
      {
        name: TRASH_EVENT_RULE_NAME,
        status: 1,
        trigger: 1,
        conditions: {
          fs_events: ["pre-delete"],
          options: { fs_paths: [{ pattern: `${trashPath}/**`, inverse_match: true }] },
        },
        actions: [
          {
            name: TRASH_EVENT_ACTION_NAME,
            order: 1,
            relation_options: { execute_sync: true, stop_on_failure: true },
          },
        ],
      },
    ],
  };
}

/**
 * Builds the JSON document SFTPGo loads at startup via SFTPGO_LOADDATA_FROM.
 * Pure: given the same users, folders, dataDir, and trash option it always
 * returns the same dump. Passwords are passed through in plain text;
 * SFTPGo hashes them itself when it loads the dump.
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
    ...(opts.trash === undefined ? {} : buildTrashEventConfig(opts.trash.path)),
  };
}
