import type { OrganizeProposal, OrganizeSuggestion } from "@fdrive/contracts";
import {
  baseName,
  isStorageError,
  isUnderPath,
  joinPath,
  normalizePath,
  parentPath,
  type StorageProvider,
} from "@fdrive/core";
import type { OrganizeItem, OrganizeSubmission } from "./agent.ts";

/** Longest reason or summary kept from the model; the review shows one line. */
const MAX_REASON_CHARS = 300;
const MAX_SUMMARY_CHARS = 1000;
const STAT_CONCURRENCY = 8;

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function tryNormalize(path: string): string | null {
  try {
    return normalizePath(path);
  } catch {
    return null;
  }
}

type Occupancy = "free" | "file" | "dir";

/**
 * Turns the model's submission into a proposal the person can trust: every
 * suggestion names a selected item, a real destination outside Trash and
 * outside the selection, and says whether its folder is new or its target
 * is already taken. Anything unusable becomes an unchanged item with the
 * reason it was set aside. Nothing is moved here.
 */
export async function buildProposal(input: {
  storage: StorageProvider;
  items: readonly OrganizeItem[];
  submission: OrganizeSubmission;
  trashPath: string | null;
}): Promise<OrganizeProposal> {
  const itemsByPath = new Map(input.items.map((item) => [item.path, item]));
  const selectedDirs = input.items.filter((item) => item.kind === "dir").map((item) => item.path);
  const decided = new Set<string>();
  const unchanged: OrganizeProposal["unchanged"] = [];
  const planned: { item: OrganizeItem; destination: string; target: string; reason: string }[] = [];

  function keep(path: string, reason: string) {
    decided.add(path);
    unchanged.push({ path, reason: clip(reason, MAX_REASON_CHARS) });
  }

  for (const move of input.submission.moves) {
    const path = tryNormalize(move.path);
    const item = path === null ? undefined : itemsByPath.get(path);
    if (item === undefined || decided.has(item.path)) continue;
    const destination = tryNormalize(move.destination);
    if (destination === null) {
      keep(item.path, "The suggested folder was not a valid path.");
    } else if (destination === parentPath(item.path)) {
      keep(item.path, move.reason);
    } else if (
      input.trashPath !== null &&
      (destination === input.trashPath || isUnderPath(input.trashPath, destination))
    ) {
      keep(item.path, "The suggested folder is in Trash.");
    } else if (selectedDirs.some((dir) => destination === dir || isUnderPath(dir, destination))) {
      keep(item.path, "The suggested folder is itself part of the selection.");
    } else {
      decided.add(item.path);
      planned.push({
        item,
        destination,
        target: joinPath(destination, baseName(item.path)),
        reason: clip(move.reason, MAX_REASON_CHARS),
      });
    }
  }
  for (const entry of input.submission.unchanged) {
    const path = tryNormalize(entry.path);
    if (path !== null && itemsByPath.has(path) && !decided.has(path)) keep(path, entry.reason);
  }
  for (const item of input.items)
    if (!decided.has(item.path)) keep(item.path, "The assistant made no suggestion for this item.");

  const occupancy = new Map<string, Promise<Occupancy>>();
  function occupied(path: string): Promise<Occupancy> {
    let pending = occupancy.get(path);
    if (pending === undefined) {
      pending = input.storage.stat(path).then(
        (stat) => (stat.kind === "dir" ? "dir" : "file"),
        (error: unknown) => {
          if (isStorageError(error) && error.kind === "not_found") return "free";
          throw error;
        },
      );
      occupancy.set(path, pending);
    }
    return pending;
  }

  const claimed = new Set<string>();
  const suggestions: OrganizeSuggestion[] = new Array(planned.length);
  let next = 0;
  async function worker() {
    while (next < planned.length) {
      const index = next++;
      const plan = planned[index] as (typeof planned)[number];
      const [folder, target] = await Promise.all([
        occupied(plan.destination),
        occupied(plan.target),
      ]);
      suggestions[index] = {
        path: plan.item.path,
        kind: plan.item.kind,
        destination: plan.destination,
        target: plan.target,
        reason: plan.reason,
        newFolder: folder === "free",
        conflict: folder === "file" || target !== "free",
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, planned.length) }, worker));
  // Two suggestions landing on one name would collide on apply: flag every one after the first.
  for (const suggestion of suggestions) {
    if (claimed.has(suggestion.target)) suggestion.conflict = true;
    claimed.add(suggestion.target);
  }

  return {
    summary: clip(input.submission.summary, MAX_SUMMARY_CHARS),
    suggestions,
    unchanged,
  };
}
