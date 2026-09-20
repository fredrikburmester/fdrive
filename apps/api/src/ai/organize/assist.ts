import type { OrganizeSharing, OrganizeSuggestion } from "@fdrive/contracts";
import { baseName, parentPath, type StorageProvider } from "@fdrive/core";
import { AiProviderError } from "../model.ts";
import { formatSize } from "../tools/tool.ts";
import type { TypeSafeAnswer, TypeSafeClient, TypeSafeQuestion } from "../typesafe.ts";
import type { OrganizeItem } from "./agent.ts";

/**
 * The second opinion Organize can ask TypeSafe for. It runs either side of
 * the agent loop and never blocks it: every failure here leaves the run
 * exactly as it would have been without the assist.
 *
 * Only names, sizes, dates and folder paths are sent. File contents are not,
 * even when the person shared them with the organizer: the triage question is
 * about what a name alone says, and the verification only needs to know what
 * kind of thing a folder holds.
 */

/** Questions per request. Every question in one request is evaluated in parallel. */
const CHUNK = 50;
/** Requests in flight at once. */
const CONCURRENCY = 3;
/** Below this probability that its name says enough, an item is worth investigating. */
const NAME_SAYS_ENOUGH = 0.5;
/** Below this probability of the top level, a suggested destination is flagged. */
const MIN_FIT = 0.5;
/** Names listed from a destination folder, as a sample of what it holds. */
const SAMPLE_NAMES = 24;

function modifiedOn(item: OrganizeItem): string | undefined {
  return item.modifiedAt === null ? undefined : item.modifiedAt.toISOString().slice(0, 10);
}

/** One request's questions and the item paths their ids stand for. */
interface Batch {
  readonly state: unknown;
  readonly questions: Record<string, TypeSafeQuestion>;
  readonly paths: readonly string[];
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    chunks.push(values.slice(index, index + size));
  return chunks;
}

/**
 * Runs every batch, keeping only the answers that arrived. A batch that fails
 * contributes nothing rather than failing the run; an abort still propagates,
 * so cancelling a run stops here too.
 */
async function askAll(
  client: TypeSafeClient,
  batches: readonly Batch[],
  signal: AbortSignal,
  keep: (path: string, answer: TypeSafeAnswer) => void,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++] as Batch;
      signal.throwIfAborted();
      let answers: Record<string, TypeSafeAnswer>;
      try {
        answers = await client.systemOne(
          { state: batch.state, questions: batch.questions },
          signal,
        );
      } catch (error) {
        if (signal.aborted || !(error instanceof AiProviderError)) throw error;
        continue;
      }
      batch.paths.forEach((path, index) => {
        const answer = answers[`q${index}`];
        if (answer !== undefined) keep(path, answer);
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
}

/**
 * Marks the selected items whose own name says too little to place them. The
 * organizer is told which ones those are, so it spends its turns reading and
 * comparing those instead of working the same thing out for every item.
 */
export async function triageNames(input: {
  client: TypeSafeClient;
  items: readonly OrganizeItem[];
  signal: AbortSignal;
}): Promise<ReadonlySet<string>> {
  const batches = chunk(input.items, CHUNK).map((group): Batch => {
    const questions: Record<string, TypeSafeQuestion> = {};
    group.forEach((_item, index) => {
      questions[`q${index}`] = {
        type: "noul",
        instructions: `Does the name of \`items[${index}]\` say enough on its own to tell what the item is and which folder in this drive it belongs in?`,
        criteria: {
          true: "The name states a subject, correspondent, project, document type, event or date that places it.",
          false:
            "The name is automatic or generic and says little about the contents: scanner and camera defaults such as scan001.pdf or IMG_2231.jpg, numbered duplicates such as document(3).docx, or bare words such as new, final or untitled.",
        },
      };
    });
    return {
      state: {
        drive: "One person's file drive.",
        items: group.map((item) => ({
          name: baseName(item.path),
          kind: item.kind,
          folder: parentPath(item.path),
          ...(item.kind === "file" ? { size: formatSize(item.size) } : {}),
          ...(modifiedOn(item) !== undefined ? { modified: modifiedOn(item) } : {}),
        })),
      },
      questions,
      paths: group.map((item) => item.path),
    };
  });

  const unclear = new Set<string>();
  await askAll(input.client, batches, input.signal, (path, answer) => {
    if (answer.type === "noul" && answer.noul < NAME_SAYS_ENOUGH) unclear.add(path);
  });
  return unclear;
}

/** The levels the fit question is scored against, lowest first. */
const FIT_LEVELS = [
  "Wrong: that folder is for a different kind of thing, and moving the item there would be a mistake.",
  "Unclear: the folder is possible, but nothing in the item's name, kind or date ties it to what that folder holds.",
  "Right: the item clearly belongs with what that folder already holds.",
];

const TOP_LEVEL = String(FIT_LEVELS.length - 1);

/** A sample of what each existing destination holds, for folders the person agreed to share names from. */
async function destinationContents(
  storage: StorageProvider,
  suggestions: readonly OrganizeSuggestion[],
  signal: AbortSignal,
): Promise<Map<string, string[]>> {
  const folders = [
    ...new Set(suggestions.filter((suggestion) => !suggestion.newFolder).map((s) => s.destination)),
  ];
  const contents = new Map<string, string[]>();
  let next = 0;
  async function worker() {
    while (next < folders.length) {
      const folder = folders[next++] as string;
      signal.throwIfAborted();
      try {
        const entries = await storage.list(folder);
        contents.set(
          folder,
          entries.slice(0, SAMPLE_NAMES).map((entry) => entry.name),
        );
      } catch {
        // A folder that cannot be listed simply goes without a sample.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, folders.length) }, worker));
  return contents;
}

/**
 * Flags suggestions whose destination looks wrong for the item. `buildProposal`
 * has already checked that the destination is a real, usable folder; this is
 * the only check on whether it makes any sense.
 */
export async function verifySuggestions(input: {
  client: TypeSafeClient;
  storage: StorageProvider;
  suggestions: readonly OrganizeSuggestion[];
  share: OrganizeSharing;
  signal: AbortSignal;
}): Promise<ReadonlySet<string>> {
  if (input.suggestions.length === 0) return new Set();
  // Sibling names belong to files outside the selection, so they are only sent
  // when the person shared those names with the organizer in the first place.
  const contents = input.share.otherFileNames
    ? await destinationContents(input.storage, input.suggestions, input.signal)
    : new Map<string, string[]>();

  const batches = chunk(input.suggestions, CHUNK).map((group): Batch => {
    const questions: Record<string, TypeSafeQuestion> = {};
    group.forEach((_suggestion, index) => {
      questions[`q${index}`] = {
        type: "score",
        instructions: `How well does the item in \`suggestions[${index}]\` fit the folder \`suggestions[${index}].destination\`?`,
        criteria: FIT_LEVELS,
      };
    });
    return {
      state: {
        drive:
          "One person's file drive. Each suggestion moves an item to a folder elsewhere in it.",
        suggestions: group.map((suggestion) => {
          const holds = contents.get(suggestion.destination);
          return {
            item: baseName(suggestion.path),
            kind: suggestion.kind,
            movingFrom: parentPath(suggestion.path),
            destination: suggestion.destination,
            ...(suggestion.newFolder ? { destinationIsNew: true } : {}),
            ...(holds !== undefined && holds.length > 0 ? { destinationHolds: holds } : {}),
          };
        }),
      },
      questions,
      paths: group.map((suggestion) => suggestion.path),
    };
  });

  const doubtful = new Set<string>();
  await askAll(input.client, batches, input.signal, (path, answer) => {
    if (answer.type !== "score") return;
    // The probability of the top level, not `confidence`: a confidently wrong
    // destination concentrates probability on "Wrong", which reads as high
    // confidence, and is exactly what this is here to catch.
    const fits = answer.probabilities[TOP_LEVEL] ?? 0;
    if (fits < MIN_FIT) doubtful.add(path);
  });
  return doubtful;
}
