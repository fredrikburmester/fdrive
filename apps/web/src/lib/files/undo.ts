import type { TrashEntry } from "@fdrive/contracts";
import { toast } from "sonner";

interface Undoable {
  readonly run: () => Promise<unknown>;
  toastId?: string | number;
  done: boolean;
}

/** The one action ⌘Z reverses, kept in memory for the tab. */
let latest: Undoable | null = null;

/**
 * Shows `message` as a success toast whose Undo runs `undo`, and makes it what ⌘Z reverses
 * next, replacing the one before: one level, no redo. `undo` reports its own failures.
 */
export function offerUndo(message: string, undo: () => Promise<unknown>): void {
  const entry: Undoable = { run: undo, done: false };
  entry.toastId = toast.success(message, {
    action: { label: "Undo", onClick: () => void runUndo(entry) },
  });
  latest = entry;
}

/** Reverses the latest action offered, unless it was already undone. */
export function undoLatest(): Promise<void> {
  return latest === null ? Promise.resolve() : runUndo(latest);
}

async function runUndo(entry: Undoable): Promise<void> {
  if (entry.done) return;
  entry.done = true;
  if (latest === entry) latest = null;
  toast.dismiss(entry.toastId);
  await entry.run().catch(() => undefined);
}

/**
 * The Trash entries `paths` just went to: the first match for each, since the Trash lists the
 * newest first and the same path may have been deleted before.
 */
export function latestTrashIds(entries: readonly TrashEntry[], paths: readonly string[]): string[] {
  return paths.flatMap((path) => entries.find((entry) => entry.originalPath === path)?.id ?? []);
}
