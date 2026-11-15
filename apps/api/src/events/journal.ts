import type { FsEvent } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";
import type { Change, ChangeJournal, Identity } from "@fdrive/db";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import type { ConfiguredMappingsResult } from "../scoping/types.ts";
import type { EventBus } from "./bus.ts";

/** The API's name in `idx.change_cursors`. */
export const JOURNAL_CONSUMER = "api";

/** Rows read at a time. */
export const JOURNAL_PAGE = 500;

/** How long a failed read waits before the next try, when nothing wakes the reader sooner. */
export const JOURNAL_RETRY_MS = 5_000;

/** A login and the scopes it reaches now: its home plus every folder shared with it. */
export interface Login {
  readonly id: string;
  readonly accountId: string;
  readonly username: string;
  readonly scopes: readonly Scope[];
}

/** One journal row in one login's files: each end its scopes reach, or `null`. */
export interface SeenChange {
  readonly change: Change;
  readonly path: string | null;
  /** Where a move went; always `null` for a row without `targetPath`. */
  readonly target: string | null;
}

/** `change` as `scopes` see it, or `null` when they reach neither end. */
export function seenBy(scopes: readonly Scope[], change: Change): SeenChange | null {
  const path = roundTripVirtualPath(scopes, change.root, `/${change.path}`);
  const target =
    change.targetPath === null
      ? null
      : roundTripVirtualPath(scopes, change.root, `/${change.targetPath}`);
  return path === null && target === null ? null : { change, path, target };
}

/**
 * The browser's event for a row: a move when the login sees both ends,
 * otherwise "look again" at the end it sees (a move out of its files leaves
 * the source, one into them adds the target).
 */
export function fsEventFor(seen: SeenChange): FsEvent {
  const at = seen.change.createdAt.toISOString();
  if (seen.path !== null && seen.target !== null)
    return { type: "fs", op: "move", paths: [seen.path], targetPaths: [seen.target], at };
  return { type: "fs", op: "change", paths: [(seen.path ?? seen.target) as string], at };
}

export interface JournalLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JournalFanoutDeps {
  readonly journal: Pick<ChangeJournal, "read" | "end" | "epoch" | "cursor" | "saveCursor">;
  /** The index root the files folder is read under, the only one logins' scopes reach. */
  readonly root: string;
  readonly identities: { listAll(): Promise<readonly Identity[]> };
  /** A login's scopes by its username: its home and the folders shared with it, no storage read. */
  readonly scopes: (username: string) => Promise<ConfiguredMappingsResult>;
  readonly bus: EventBus;
  /**
   * Brings path-keyed metadata and personal activity along with a change
   * fdrive did not make (a row from the watcher, a scan or OCR), for one
   * login that sees it. fdrive's own changes moved them in the request.
   */
  readonly outside: (login: Login, seen: SeenChange) => Promise<void>;
  readonly logger: JournalLogger;
  readonly pageSize?: number;
  readonly retryMs?: number;
}

export interface JournalFanout {
  /** Reads the epoch and the saved position (the journal's end without one), then catches up. */
  start(): Promise<void>;
  /** Reads what was appended since; called on every `NOTIFY idx_changes` and each reconnect. */
  wake(): void;
  /** Waits for the read in progress and stops. */
  stop(): Promise<void>;
  /** The journal's epoch, which qualifies every position handed to a browser. */
  epoch(): string;
  /**
   * The newest position whose events are published. Read in the same tick
   * as subscribing to the bus, it splits the journal exactly: every row up
   * to it was published before, every later one comes through the bus.
   */
  position(): number;
  /**
   * Sends `send` the events of rows after `after`, up to `upTo`, in the
   * files of the login named `username`, oldest first. False when rows after
   * `after` are gone (pruned) or cannot be read: the browser resyncs.
   */
  replay(
    username: string,
    after: number,
    upTo: number,
    send: (event: FsEvent, position: number) => void,
  ): Promise<boolean>;
}

/**
 * The API's one reader of the change journal (`idx.changes`), and the only
 * way it learns of file changes. It follows the files folder's root from
 * its own position in `idx.change_cursors`, maps each row once through every
 * login's scopes and publishes one `fs` event per login that sees it, so
 * each change reaches each person once, the people a folder is shared with
 * included. A row fdrive did not write also goes through `outside` first.
 *
 * Rows are read when something wakes the reader (`NOTIFY idx_changes`, sent
 * on every append, and every reconnect of that connection), never on a
 * timer; after a failed read it tries again `retryMs` later.
 */
export function createJournalFanout(deps: JournalFanoutDeps): JournalFanout {
  const pageSize = deps.pageSize ?? JOURNAL_PAGE;
  const retryMs = deps.retryMs ?? JOURNAL_RETRY_MS;
  let epoch = "";
  let position = 0;
  let started = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  async function loginsNow(): Promise<Login[]> {
    const logins: Login[] = [];
    for (const identity of await deps.identities.listAll()) {
      const scopes = await deps.scopes(identity.externalUsername);
      if (!scopes.available) continue;
      logins.push({
        id: identity.id,
        accountId: identity.accountId,
        username: identity.externalUsername,
        scopes: scopes.scopes,
      });
    }
    return logins;
  }

  async function apply(change: Change, logins: readonly Login[]): Promise<void> {
    const seen = logins.flatMap((login) => {
      const one = seenBy(login.scopes, change);
      return one === null ? [] : [{ login, seen: one }];
    });
    if (change.source !== "api") {
      for (const { login, seen: one } of seen) {
        try {
          await deps.outside(login, one);
        } catch (error) {
          deps.logger.warn(
            { error, position: change.position, login: login.id },
            "journal: metadata did not follow a change made outside fdrive",
          );
        }
      }
    }
    // Published together and then counted, in one tick: see `position`.
    for (const { login, seen: one } of seen)
      deps.bus.publish({ ...fsEventFor(one), identityId: login.id, position: change.position });
    position = change.position;
  }

  async function drain(): Promise<void> {
    for (;;) {
      const page = await deps.journal.read(deps.root, position, pageSize);
      if (page.gap) {
        // Down longer than the journal keeps rows: what came before is lost to
        // metadata, and browsers resync on their own.
        deps.logger.warn({ position }, "journal: rows after the API's position were pruned");
        position = await deps.journal.end();
        await deps.journal.saveCursor(JOURNAL_CONSUMER, deps.root, position);
        continue;
      }
      if (page.changes.length === 0) return;
      const logins = await loginsNow();
      for (const change of page.changes) {
        if (stopped) return;
        await apply(change, logins);
      }
      await deps.journal.saveCursor(JOURNAL_CONSUMER, deps.root, position);
      if (page.changes.length < pageSize) return;
    }
  }

  function wake(): void {
    if (!started || stopped) return;
    if (running !== null) {
      again = true;
      return;
    }
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await drain();
        } catch (error) {
          deps.logger.warn({ error }, "journal: read failed, trying again");
          if (!stopped && !again) {
            retry = setTimeout(() => {
              retry = null;
              wake();
            }, retryMs);
            retry.unref?.();
          }
        }
      } while (again && !stopped);
      running = null;
    })();
  }

  return {
    async start() {
      epoch = await deps.journal.epoch();
      position =
        (await deps.journal.cursor(JOURNAL_CONSUMER, deps.root)) ?? (await deps.journal.end());
      started = true;
      wake();
    },
    wake,
    async stop() {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      await running;
    },
    epoch: () => epoch,
    position: () => position,
    async replay(username, after, upTo, send) {
      try {
        const scopes = await deps.scopes(username);
        let from = after;
        while (from < upTo) {
          const page = await deps.journal.read(deps.root, from, pageSize);
          if (page.gap) return false;
          if (page.changes.length === 0) break;
          for (const change of page.changes) {
            if (change.position > upTo) return true;
            const seen = scopes.available ? seenBy(scopes.scopes, change) : null;
            if (seen !== null) send(fsEventFor(seen), change.position);
            from = change.position;
          }
        }
        return true;
      } catch (error) {
        deps.logger.warn({ error }, "journal: replay failed, the browser resyncs");
        return false;
      }
    },
  };
}
