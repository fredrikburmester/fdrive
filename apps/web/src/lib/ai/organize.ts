import type {
  AiProvider,
  MoveManyRequest,
  MoveManyResult,
  OrganizeProposal,
  OrganizeSuggestion,
} from "@fdrive/contracts";
import { baseName, joinPath } from "@fdrive/core";

/** Suggestions that share one destination folder, as the review lists them. */
export interface SuggestionGroup {
  readonly destination: string;
  readonly newFolder: boolean;
  readonly suggestions: readonly OrganizeSuggestion[];
}

/** Who receives the selection's names and excerpts, in words a person recognizes. */
export function providerLabel(provider: AiProvider | null): string {
  return provider === "anthropic" ? "Claude (Anthropic)" : "your AI server";
}

/**
 * Replaces a suggestion's destination with a folder the person picked. The
 * picker only offers existing folders, so it is never new; whether the name
 * is free is only known once the move is tried.
 */
export function withDestination(
  suggestion: OrganizeSuggestion,
  destination: string,
): OrganizeSuggestion {
  if (destination === suggestion.destination) return suggestion;
  const { uncertain: _doubted, ...rest } = suggestion;
  return {
    ...rest,
    destination,
    target: joinPath(destination, baseName(suggestion.path)),
    newFolder: false,
    conflict: false,
  };
}

/** Groups suggestions by destination: largest groups first, then by folder path. */
export function groupSuggestions(suggestions: readonly OrganizeSuggestion[]): SuggestionGroup[] {
  const groups = new Map<string, OrganizeSuggestion[]>();
  for (const suggestion of suggestions) {
    const list = groups.get(suggestion.destination) ?? [];
    list.push(suggestion);
    groups.set(suggestion.destination, list);
  }
  return [...groups.entries()]
    .map(([destination, list]) => ({
      destination,
      newFolder: list.some((suggestion) => suggestion.newFolder),
      suggestions: list,
    }))
    .sort(
      (a, b) =>
        b.suggestions.length - a.suggestions.length || a.destination.localeCompare(b.destination),
    );
}

/**
 * The paths checked when a proposal first opens: everything except known
 * conflicts and the destinations the assist doubted. Both are left for the
 * person to look at rather than applied by default.
 */
export function initiallyChecked(proposal: OrganizeProposal): Set<string> {
  return new Set(
    proposal.suggestions
      .filter((suggestion) => !suggestion.conflict && suggestion.uncertain !== true)
      .map((suggestion) => suggestion.path),
  );
}

/** The batch move request for the checked suggestions, creating new folders as needed. */
export function movesFor(
  suggestions: readonly OrganizeSuggestion[],
  checked: ReadonlySet<string>,
): MoveManyRequest | null {
  const items = suggestions
    .filter((suggestion) => checked.has(suggestion.path))
    .map((suggestion) => ({ path: suggestion.path, target: suggestion.target }));
  return items.length === 0 ? null : { items, createParents: true };
}

export interface MoveOutcome {
  readonly moved: readonly { path: string; target: string }[];
  readonly failed: readonly { path: string; message: string }[];
  readonly warnings: number;
}

export function summarizeMoves(results: readonly MoveManyResult[]): MoveOutcome {
  const moved: { path: string; target: string }[] = [];
  const failed: { path: string; message: string }[] = [];
  let warnings = 0;
  for (const result of results) {
    if (result.ok) {
      moved.push({ path: result.path, target: result.target });
      if (result.warning !== undefined) warnings += 1;
    } else {
      failed.push({ path: result.path, message: result.error.message });
    }
  }
  return { moved, failed, warnings };
}

/** Puts moved items back where they were, in reverse order. */
export function undoMoves(moved: MoveOutcome["moved"]): MoveManyRequest | null {
  if (moved.length === 0) return null;
  return {
    items: [...moved].reverse().map((move) => ({ path: move.target, target: move.path })),
  };
}

/** The latest progress steps with keys that stay stable while steps are appended. */
export function recentSteps(
  activity: readonly string[],
  limit = 8,
): { key: string; text: string }[] {
  const start = Math.max(0, activity.length - limit);
  return activity.slice(start).map((text, offset) => ({ key: `${start + offset}:${text}`, text }));
}

export function itemCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
}
