import {
  DEFAULT_TRASH_RETENTION_DAYS,
  TRASH_RETENTION_SETTINGS_KEY,
  TrashSettings,
} from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import { noopSystemEventLog, type SystemEventLog } from "../system/event-log.js";

/** Trash's one installation setting: how many days it keeps an item. */
export interface TrashSettingsService {
  /** `DEFAULT_TRASH_RETENTION_DAYS` until an administrator changes it. */
  current(): Promise<TrashSettings>;
  update(input: TrashSettings): Promise<TrashSettings>;
}

/**
 * Every Trash page and delete dialog reads the setting, so it is kept in
 * memory once read and replaced when this service saves a new one: fdrive
 * runs one API process, and nothing else writes it.
 */
export function createTrashSettingsService(deps: {
  settings: Pick<SettingsRepo, "get" | "set">;
  eventLog?: SystemEventLog;
}): TrashSettingsService {
  const eventLog = deps.eventLog ?? noopSystemEventLog;
  let cached: TrashSettings | undefined;
  return {
    async current() {
      if (cached !== undefined) return cached;
      const stored = await deps.settings.get<unknown>(TRASH_RETENTION_SETTINGS_KEY);
      cached =
        stored === null
          ? { retentionDays: DEFAULT_TRASH_RETENTION_DAYS }
          : TrashSettings.parse(stored);
      return cached;
    },
    async update(input) {
      const next = TrashSettings.parse(input);
      await deps.settings.set(TRASH_RETENTION_SETTINGS_KEY, next);
      cached = next;
      eventLog.record(
        "general",
        "info",
        `Trash keeps items for ${next.retentionDays} ${next.retentionDays === 1 ? "day" : "days"}`,
      );
      return next;
    },
  };
}
