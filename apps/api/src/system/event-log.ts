import type { SystemLogLevel, SystemLogSubsystem } from "@fdrive/contracts";
import type { SystemEventRepo } from "@fdrive/db";

/**
 * How a route or service records something an admin should be able to see
 * later. Deliberately synchronous and returning `void`: recording an event
 * is observability, never part of the operation's own success, so a caller
 * neither awaits it nor has to handle its failure.
 */
export interface SystemEventLog {
  record(
    subsystem: SystemLogSubsystem,
    level: SystemLogLevel,
    message: string,
    data?: unknown,
  ): void;
}

/** Retention per subsystem, and how often a write triggers a prune. */
export const DEFAULT_EVENT_KEEP = 2000;
export const DEFAULT_PRUNE_EVERY = 50;

/** The subset of a pino logger `createSystemEventLog` uses. */
export interface EventLogLogger {
  warn(obj: Record<string, unknown>, message: string): void;
}

export interface CreateSystemEventLogOptions {
  readonly repo: SystemEventRepo;
  readonly logger: EventLogLogger;
  /** Rows kept per subsystem; older rows are dropped by the periodic prune. */
  readonly keep?: number;
  /** Prune after every Nth insert into one subsystem. */
  readonly pruneEvery?: number;
}

/**
 * Builds the fire-and-forget event log. Writes are not awaited by callers,
 * so a failing database must never surface as a failed request: it is
 * logged at `warn` and dropped. Retention is enforced opportunistically,
 * on every `pruneEvery`th insert into a given subsystem, rather than by a
 * scheduled job.
 */
export function createSystemEventLog(opts: CreateSystemEventLogOptions): SystemEventLog {
  const keep = opts.keep ?? DEFAULT_EVENT_KEEP;
  const pruneEvery = opts.pruneEvery ?? DEFAULT_PRUNE_EVERY;
  const writes = new Map<SystemLogSubsystem, number>();

  return {
    record(subsystem, level, message, data) {
      void opts.repo
        .append({ subsystem, level, message, ...(data === undefined ? {} : { data }) })
        .then(async () => {
          const count = (writes.get(subsystem) ?? 0) + 1;
          writes.set(subsystem, count % pruneEvery);
          if (count % pruneEvery === 0) {
            await opts.repo.prune(subsystem, keep);
          }
        })
        .catch((err: unknown) => {
          opts.logger.warn({ err, subsystem, level, message }, "system event not recorded");
        });
    },
  };
}

/** An event log that records nothing, for tests and for optional injection sites. */
export const noopSystemEventLog: SystemEventLog = { record: () => {} };
