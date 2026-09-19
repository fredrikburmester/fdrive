import type { OrganizeProposal, OrganizeSuggestion } from "@fdrive/contracts";
import {
  baseName,
  isUnderPath,
  joinPath,
  normalizePath,
  parentPath,
  type StorageProvider,
} from "@fdrive/core";
import { createPathLocator, nameKey } from "../tools/stored-paths.ts";
import type { OrganizeItem, OrganizeSubmission } from "./agent.ts";

/** Longest reason or summary kept from the model; the review shows one line. */
const MAX_REASON_CHARS = 300;
const MAX_SUMMARY_CHARS = 1000;
const STAT_CONCURRENCY = 8;

const UNCHECKED = "fdrive could not check the suggested folder.";

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

/**
 * Turns the model's submission into a proposal the person can trust: every
 * suggestion names a selected item, a real destination outside Trash and
 * outside the selection, and says whether its folder is new or its target
 * is already taken. Paths are matched the way they read, so accents encoded
 * differently from the stored names still find them. Anything unusable
 * becomes an unchanged item with the reason it was set aside. Nothing is
 * moved here.
 */
export async function buildProposal(input: {
  storage: StorageProvider;
  items: readonly OrganizeItem[];
  submission: OrganizeSubmission;
  trashPath: string | null;
}): Promise<OrganizeProposal> {
  const itemsByPath = new Map(input.items.map((item) => [item.path, item]));
  const itemsByKey = new Map(input.items.map((item) => [nameKey(item.path), item]));
  const selectedDirs = input.items.filter((item) => item.kind === "dir").map((item) => item.path);
  const decided = new Set<string>();
  const unchanged: OrganizeProposal["unchanged"] = [];
  let unmatched = 0;

  function selectedItem(raw: string): OrganizeItem | undefined {
    const path = tryNormalize(raw);
    const item =
      path === null ? undefined : (itemsByPath.get(path) ?? itemsByKey.get(nameKey(path)));
    if (item === undefined) unmatched += 1;
    return item;
  }

  function keep(path: string, reason: string) {
    decided.add(path);
    unchanged.push({ path, reason: clip(reason, MAX_REASON_CHARS) });
  }

  const requested: { item: OrganizeItem; destination: string | null; reason: string }[] = [];
  for (const move of input.submission.moves) {
    const item = selectedItem(move.path);
    if (item === undefined || decided.has(item.path)) continue;
    decided.add(item.path);
    requested.push({ item, destination: tryNormalize(move.destination), reason: move.reason });
  }

  const locator = createPathLocator(input.storage);
  /** The checked suggestion, or why the item stays where it is. */
  async function check(request: (typeof requested)[number]): Promise<OrganizeSuggestion | string> {
    const { item, reason } = request;
    if (request.destination === null) return "The suggested folder was not a valid path.";
    const folder = await locator.locate(request.destination);
    if (folder.occupancy === "unknown") return UNCHECKED;
    const destination = folder.path;
    if (destination === parentPath(item.path)) return reason;
    if (
      input.trashPath !== null &&
      (destination === input.trashPath || isUnderPath(input.trashPath, destination))
    )
      return "The suggested folder is in Trash.";
    if (selectedDirs.some((dir) => destination === dir || isUnderPath(dir, destination)))
      return "The suggested folder is itself part of the selection.";
    const target = joinPath(destination, baseName(item.path));
    const occupant = await locator.locate(target);
    if (occupant.occupancy === "unknown") return UNCHECKED;
    return {
      path: item.path,
      kind: item.kind,
      destination,
      target,
      reason: clip(reason, MAX_REASON_CHARS),
      newFolder: folder.occupancy === "free",
      conflict: folder.occupancy === "file" || occupant.occupancy !== "free",
    };
  }

  const outcomes: (OrganizeSuggestion | string)[] = new Array(requested.length);
  let next = 0;
  async function worker() {
    while (next < requested.length) {
      const index = next++;
      outcomes[index] = await check(requested[index] as (typeof requested)[number]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, requested.length) }, worker));

  const suggestions: OrganizeSuggestion[] = [];
  requested.forEach(({ item }, index) => {
    const outcome = outcomes[index] as OrganizeSuggestion | string;
    if (typeof outcome === "string") keep(item.path, outcome);
    else suggestions.push(outcome);
  });
  for (const entry of input.submission.unchanged) {
    const item = selectedItem(entry.path);
    if (item !== undefined && !decided.has(item.path)) keep(item.path, entry.reason);
  }
  const unmentioned =
    unmatched > 0
      ? "The assistant's suggestions did not name this item's path."
      : "The assistant made no suggestion for this item.";
  for (const item of input.items) if (!decided.has(item.path)) keep(item.path, unmentioned);

  // Two suggestions landing on one name, however its accents are encoded, would collide on apply.
  const claimed = new Set<string>();
  for (const suggestion of suggestions) {
    const key = nameKey(suggestion.target);
    if (claimed.has(key)) suggestion.conflict = true;
    claimed.add(key);
  }

  return {
    summary: clip(input.submission.summary, MAX_SUMMARY_CHARS),
    suggestions,
    unchanged,
  };
}
