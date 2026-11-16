import type { TrashItemRepo } from "@fdrive/db";
import type { SystemEventLog } from "../system/event-log.js";
import type { TrashItems } from "./items.js";

export interface TrashStartupDeps {
  readonly items: Pick<TrashItems, "settle">;
  readonly repo: Pick<TrashItemRepo, "pending">;
  readonly eventLog: Pick<SystemEventLog, "record">;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the API does with Trash when it starts, before it serves anyone, so
 * nothing else is on its way into Trash meanwhile: it settles each item an
 * interrupted delete left on its way into Trash (`TrashItems.settle`). In
 * Trash, it arrives; still where it was, it stays there. One that cannot be
 * settled now waits for the next start.
 */
export async function settleTrashAtStart(deps: TrashStartupDeps): Promise<void> {
  for (const item of await deps.repo.pending()) {
    try {
      await deps.items.settle(item);
    } catch (error) {
      deps.eventLog.record(
        "general",
        "warn",
        "An item on its way into Trash waits for the next start",
        {
          identityId: item.identityId,
          id: item.id,
          error: errorText(error),
        },
      );
    }
  }
}
