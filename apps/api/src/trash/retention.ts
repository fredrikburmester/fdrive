import type { IdentityRepo } from "@fdrive/db";
import type { PersonalActivityService } from "../activity/service.js";
import type { Principal } from "../auth/principal.js";
import type { IdentityStorageFactory } from "../auth/storage-factory.js";
import { ApiHttpError } from "../errors.js";
import type { MetadataService } from "../metadata/service.js";
import type { SystemEventLog } from "../system/event-log.js";
import { purgeTrashItem } from "./routes.js";
import type { TrashSettingsService } from "./settings.js";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface TrashRetentionDeps {
  readonly identities: Pick<IdentityRepo, "listAll">;
  /** Each login's storage, with its Trash; refuses a disabled or removed user. */
  readonly storageFor: IdentityStorageFactory;
  readonly settings: Pick<TrashSettingsService, "current">;
  readonly activity: PersonalActivityService;
  readonly metadata: MetadataService;
  readonly clock: () => Date;
  readonly eventLog: Pick<SystemEventLog, "record">;
}

/**
 * Deletes for good what each user's Trash has kept longer than the
 * installation's retention, item by item through the same purge as
 * **Delete permanently** (`purgeTrashItem`), so history, shares and links
 * follow. A user who may not sign in keeps their Trash until they may again.
 * Runs hourly, the first time an hour after start, so an administrator who
 * upgrades has that long to keep old items longer; a failure defers that
 * item to the next pass.
 */
export function createTrashRetention(deps: TrashRetentionDeps) {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;

  async function sweep(): Promise<{ purged: number; deferred: number }> {
    const { retentionDays } = await deps.settings.current();
    const cutoff = deps.clock().getTime() - retentionDays * DAY_MS;
    const results = { purged: 0, deferred: 0 };
    for (const identity of await deps.identities.listAll()) {
      if (stopped) break;
      let principal: Principal;
      try {
        principal = {
          accountId: identity.accountId,
          identityId: identity.id,
          username: identity.username,
          storage: await deps.storageFor(identity.id),
          isAdmin: false,
        };
      } catch (error) {
        if (error instanceof ApiHttpError && error.kind === "forbidden") continue;
        throw error;
      }
      const { entries } = await principal.storage.trash.list({
        limit: Number.POSITIVE_INFINITY,
      });
      for (const entry of entries) {
        if (stopped) break;
        if (entry.deletedAt.getTime() > cutoff) continue;
        try {
          await purgeTrashItem(deps, principal, entry.id, { source: "api", reason: "retention" });
          results.purged += 1;
        } catch (error) {
          results.deferred += 1;
          deps.eventLog.record("general", "warn", "Trash retention deferred an item", {
            identityId: identity.id,
            id: entry.id,
            error: errorText(error),
          });
        }
      }
    }
    if (results.purged > 0)
      deps.eventLog.record(
        "general",
        "info",
        `Trash deleted ${results.purged} ${results.purged === 1 ? "item" : "items"} kept longer than ${retentionDays} ${retentionDays === 1 ? "day" : "days"}`,
      );
    return results;
  }

  function run() {
    if (stopped || active) return active ?? Promise.resolve();
    active = sweep()
      .then(() => undefined)
      .catch((error: unknown) => {
        deps.eventLog.record("general", "error", "Trash retention failed", {
          error: errorText(error),
        });
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  }

  return {
    sweep,
    start() {
      if (timer || stopped) return;
      timer = setInterval(run, HOUR_MS);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
