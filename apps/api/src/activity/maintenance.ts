import type { ActivityReadsRepo, ActivityRepo } from "@fdrive/db";

export interface ActivityMaintenanceDeps {
  readonly repo: ActivityRepo;
  readonly reads: ActivityReadsRepo;
  readonly clock: () => Date;
  readonly onError: (error: unknown) => void;
}
/** Repair metadata only. An expired running intent is never permission to replay storage I/O. */
export function createActivityMaintenance(deps: ActivityMaintenanceDeps) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let current: Promise<void> | undefined;
  async function run() {
    await deps.reads.seal();
    const abandonedBefore = new Date(deps.clock().getTime() - 600_000);
    const pending = await deps.repo.pending(abandonedBefore);
    for (const operation of pending) {
      await deps.repo.recoverAbandoned(
        operation.ownerAccountId,
        operation.id,
        {
          outcome: operation.state === "prepared" ? "cancelled" : "unknown",
          errorCode: operation.state === "prepared" ? "not_started" : "outcome_unconfirmed",
          detail: { reason: "interrupted" },
        },
        abandonedBefore,
      );
    }
  }
  function tick() {
    if (!current)
      current = run()
        .catch(deps.onError)
        .finally(() => {
          current = undefined;
        });
  }
  return {
    run,
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, 30_000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await current;
    },
  };
}
