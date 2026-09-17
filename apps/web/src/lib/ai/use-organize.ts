"use client";

import type { FsEntry, OrganizeRun, OrganizeSharing } from "@fdrive/contracts";
import { useEffect } from "react";
import { toast } from "sonner";
import { describeFsError } from "@/lib/files/queries";
import { itemCount } from "./organize";
import {
  type OrganizeSession,
  type ReviewEdits,
  samePaths,
  useOrganizeSessionStore,
} from "./organize-session";
import { useCancelOrganize, useOrganizeRun, useStartOrganize } from "./queries";

/** What a closed sheet is still busy with, for a way back into it. */
export interface OrganizeStatus {
  readonly state: "running" | "ready";
  readonly count: number;
}

export interface OrganizeController {
  readonly session: OrganizeSession | null;
  /** The session's run as last polled; `undefined` before a run starts. */
  readonly run: OrganizeRun | undefined;
  /** Why the run could not be read, if polling failed. */
  readonly runError: unknown;
  /** Whether a run is starting or in progress. */
  readonly running: boolean;
  readonly stopping: boolean;
  /** Set while the sheet is closed on a run in progress or suggestions waiting for review. */
  readonly status: OrganizeStatus | null;
  /** Opens the sheet for `entries`, resuming the session about that same selection. */
  open(entries: readonly FsEntry[]): void;
  show(): void;
  /** Closes the sheet. A run in progress or a proposal under review is kept; anything else is dropped. */
  hide(): void;
  discard(): void;
  setInstructions(value: string): void;
  setShare(patch: Partial<OrganizeSharing>): void;
  /** Starts a run for the session's selection. Failures are reported with a toast. */
  start(): Promise<void>;
  /** Stops the run in progress. */
  stop(): void;
  /** Drops the run and review to ask again. */
  restart(): void;
  setEdits(edits: ReviewEdits): void;
}

/**
 * Drives one Organize session. The session lives in a store, so closing the
 * sheet or moving between folders neither stops the assistant nor loses a
 * review in progress; a toast and a pill at the bottom right lead back to it.
 */
export function useOrganize(): OrganizeController {
  const session = useOrganizeSessionStore((store) => store.session);
  const actions = useOrganizeSessionStore.getState();
  const start = useStartOrganize();
  const cancel = useCancelOrganize();
  const runQuery = useOrganizeRun(session?.runId ?? null);
  const run = runQuery.data;
  const state = run?.state;
  const running = start.isPending || state === "running";
  const reviewing = state === "done";
  // A run that started but has not been read yet is worth keeping too.
  const keep =
    running || reviewing || (session !== null && session.runId !== null && !runQuery.isError);

  const hidden = session !== null && !session.open;
  const status: OrganizeStatus | null = !hidden
    ? null
    : running
      ? { state: "running", count: session.entries.length }
      : reviewing
        ? { state: "ready", count: session.entries.length }
        : null;

  useEffect(() => {
    if (!hidden || !reviewing || session.notified) return;
    actions.markNotified();
    toast.info("Suggestions ready", {
      description: `Where ${itemCount(session.entries.length)} could go.`,
      action: { label: "Review", onClick: () => actions.show() },
    });
  }, [hidden, reviewing, session, actions]);

  return {
    session,
    run,
    runError: runQuery.error,
    running,
    stopping: cancel.isPending,
    status,
    open(entries) {
      const current = useOrganizeSessionStore.getState().session;
      // Another selection replaces the session; stop its assistant rather than leave it working unseen.
      if (current !== null && !samePaths(current.entries, entries)) {
        if (current.runId !== null && state === "running") cancel.mutate(current.runId);
        start.reset();
      }
      actions.open(entries);
    },
    show: actions.show,
    hide() {
      if (!keep) {
        actions.discard();
        return;
      }
      // A review the person has already seen needs no toast when it stays put.
      if (reviewing) actions.markNotified();
      actions.hide();
    },
    discard: actions.discard,
    setInstructions: actions.setInstructions,
    setShare: actions.setShare,
    async start() {
      const current = useOrganizeSessionStore.getState().session;
      if (current === null) return;
      let started: OrganizeRun;
      try {
        started = await start.mutateAsync({
          paths: current.entries.map((entry) => entry.path),
          ...(current.instructions.trim() ? { instructions: current.instructions.trim() } : {}),
          share: current.share,
        });
      } catch (error) {
        toast.error(describeFsError(error, "Could not start organizing."));
        return;
      }
      // The session may be gone or replaced by now; stop the run it started.
      if (useOrganizeSessionStore.getState().session?.key === current.key)
        actions.setRunId(current.key, started.id);
      else cancel.mutate(started.id);
    },
    stop() {
      const id = useOrganizeSessionStore.getState().session?.runId;
      if (id !== null && id !== undefined) cancel.mutate(id);
    },
    restart() {
      actions.restart();
      start.reset();
    },
    setEdits: actions.setEdits,
  };
}
