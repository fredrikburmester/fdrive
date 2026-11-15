import {
  DEFAULT_STORAGE_NAME,
  STORAGE_NAME_SETTINGS_KEY,
  StorageName,
  type SystemStorage,
} from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import type { FilesFolder } from "@fdrive/local";
import { z } from "zod";
import { noopSystemEventLog, type SystemEventLog } from "./event-log.js";

const StoredName = z.object({ name: StorageName });

/** The files folder as an installation setting: its name, and its health. */
export interface StorageService {
  /** The storage name, `DEFAULT_STORAGE_NAME` until an administrator renames it. */
  name(): Promise<string>;
  /** The files folder as System > General shows it. */
  view(): Promise<SystemStorage>;
  rename(name: string): Promise<SystemStorage>;
}

export function createStorageService(deps: {
  /** The files folder's provider row. */
  storageId: string;
  settings: Pick<SettingsRepo, "get" | "set">;
  folder: Pick<FilesFolder, "health">;
  eventLog?: SystemEventLog;
}): StorageService {
  const eventLog = deps.eventLog ?? noopSystemEventLog;

  async function name(): Promise<string> {
    const stored = await deps.settings.get<unknown>(STORAGE_NAME_SETTINGS_KEY);
    return stored === null ? DEFAULT_STORAGE_NAME : StoredName.parse(stored).name;
  }

  async function view(): Promise<SystemStorage> {
    const [current, health] = await Promise.all([name(), deps.folder.health()]);
    return { id: deps.storageId, name: current, healthy: health.ok, detail: health.detail };
  }

  return {
    name,
    view,
    async rename(next) {
      const stored = StoredName.parse({ name: next });
      await deps.settings.set(STORAGE_NAME_SETTINGS_KEY, stored);
      eventLog.record("general", "info", `Storage renamed: ${stored.name}`);
      return view();
    },
  };
}
