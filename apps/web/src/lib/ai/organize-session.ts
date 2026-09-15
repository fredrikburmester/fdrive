import type { FsEntry, OrganizeProposal, OrganizeSuggestion } from "@fdrive/contracts";
import { joinPath } from "@fdrive/core";
import { create } from "zustand";
import { initiallyChecked, withDestination } from "./organize";

/**
 * What the person changed while reviewing a proposal, kept apart from the
 * proposal itself so the review survives the sheet closing and reopening.
 */
export interface ReviewEdits {
  /** Paths kept checked, or `null` while the proposal's defaults still apply. */
  readonly checked: ReadonlySet<string> | null;
  /** Folders chosen by hand, by item path. */
  readonly destinations: ReadonlyMap<string, string>;
  /** New names chosen to keep both an item and what already has its name, by item path. */
  readonly names: ReadonlyMap<string, string>;
  /** Items an earlier, partly failed apply already moved. */
  readonly moved: ReadonlySet<string>;
  /** Why the last apply could not move an item, by path. */
  readonly failures: ReadonlyMap<string, string>;
}

export const NO_EDITS: ReviewEdits = {
  checked: null,
  destinations: new Map(),
  names: new Map(),
  moved: new Set(),
  failures: new Map(),
};

/**
 * One Organize request from the moment the sheet opens until its moves are
 * applied or the person gives it up. It outlives the sheet: closing the sheet
 * hides the session, and the run keeps going on the server.
 */
export interface OrganizeSession {
  /** Tells a session apart from the one that replaced it. */
  readonly key: number;
  readonly entries: readonly FsEntry[];
  /** Whether the sheet shows the session right now. */
  readonly open: boolean;
  readonly instructions: string;
  readonly runId: string | null;
  readonly edits: ReviewEdits;
  /** Whether the person was told that suggestions arrived while the sheet was closed. */
  readonly notified: boolean;
}

export interface OrganizeSessionStore {
  readonly session: OrganizeSession | null;
  /**
   * Opens the sheet for `entries`. The selection the current session is
   * about resumes it; any other selection starts a fresh session.
   */
  open(entries: readonly FsEntry[]): void;
  /** Shows the current session again. */
  show(): void;
  /** Hides the sheet but keeps the session. */
  hide(): void;
  /** Forgets the session. */
  discard(): void;
  setInstructions(value: string): void;
  /** Attaches a started run to the session with `key`; ignored once that session is gone. */
  setRunId(key: number, id: string): void;
  /** Drops the run and review, keeping the selection and instructions. */
  restart(): void;
  setEdits(edits: ReviewEdits): void;
  markNotified(): void;
  reset(): void;
}

/** Whether two selections name the same items in the same order. */
export function samePaths(a: readonly FsEntry[], b: readonly FsEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.path === b[index]?.path);
}

export function createOrganizeSessionStore() {
  let nextKey = 1;
  return create<OrganizeSessionStore>((set) => {
    function update(change: (session: OrganizeSession) => OrganizeSession): void {
      set((state) => (state.session === null ? state : { session: change(state.session) }));
    }
    return {
      session: null,
      open(entries) {
        set((state) => {
          if (state.session !== null && samePaths(state.session.entries, entries))
            return { session: { ...state.session, open: true } };
          nextKey += 1;
          return {
            session: {
              key: nextKey,
              entries,
              open: true,
              instructions: "",
              runId: null,
              edits: NO_EDITS,
              notified: false,
            },
          };
        });
      },
      show: () => update((session) => ({ ...session, open: true })),
      hide: () => update((session) => ({ ...session, open: false })),
      discard: () => set({ session: null }),
      setInstructions: (value) => update((session) => ({ ...session, instructions: value })),
      setRunId: (key, id) =>
        update((session) => (session.key === key ? { ...session, runId: id } : session)),
      restart: () =>
        update((session) => ({ ...session, runId: null, edits: NO_EDITS, notified: false })),
      setEdits: (edits) => update((session) => ({ ...session, edits })),
      markNotified: () => update((session) => ({ ...session, notified: true })),
      reset: () => set({ session: null }),
    };
  });
}

/** The app-wide Organize session, reset with the other stores when the login changes. */
export const useOrganizeSessionStore = createOrganizeSessionStore();

/** The proposal's suggestions as the review shows them: moved ones gone, chosen folders applied. */
export function reviewSuggestions(
  proposal: OrganizeProposal,
  edits: ReviewEdits,
): OrganizeSuggestion[] {
  return proposal.suggestions
    .filter((suggestion) => !edits.moved.has(suggestion.path))
    .map((suggestion) => {
      const destination = edits.destinations.get(suggestion.path);
      const placed =
        destination === undefined ? suggestion : withDestination(suggestion, destination);
      const name = edits.names.get(suggestion.path);
      return name === undefined
        ? placed
        : { ...placed, target: joinPath(placed.destination, name), conflict: false };
    });
}

/** The paths the review has checked: the person's choice, or the proposal's defaults. */
export function reviewChecked(proposal: OrganizeProposal, edits: ReviewEdits): ReadonlySet<string> {
  const checked = edits.checked ?? initiallyChecked(proposal);
  if (edits.moved.size === 0) return checked;
  return new Set([...checked].filter((path) => !edits.moved.has(path)));
}
