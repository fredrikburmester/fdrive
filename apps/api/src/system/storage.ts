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
  settings: Pick<SettingsRepo, "get" | "set">;
  folder: Pick<FilesFolder, "health">;
  eventLog?: SystemEventLog;
}): StorageService {
  const eventLog = deps.eventLog ?? noopSystemEventLog;
  // Every `/auth/me` reads the name: kept once read, and replaced on rename,
  // since nothing else writes it.
  let current: string | undefined;

  async function name(): Promise<string> {
    if (current !== undefined) return current;
    const stored = await deps.settings.get<unknown>(STORAGE_NAME_SETTINGS_KEY);
    current = stored === null ? DEFAULT_STORAGE_NAME : StoredName.parse(stored).name;
    return current;
  }

  async function view(): Promise<SystemStorage> {
    const [named, health] = await Promise.all([name(), deps.folder.health()]);
    return { name: named, healthy: health.ok, detail: health.detail };
  }

  return {
    name,
    view,
    async rename(next) {
      const stored = StoredName.parse({ name: next });
      await deps.settings.set(STORAGE_NAME_SETTINGS_KEY, stored);
      current = stored.name;
      eventLog.record("general", "info", `Storage renamed: ${stored.name}`);
      return view();
    },
  };
}
