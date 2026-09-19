import { DEFAULT_ORGANIZE_SHARING, type OrganizeSharing } from "@fdrive/contracts";
import {
  baseName,
  type FileEntry,
  isUnderPath,
  normalizePath,
  parentPath,
  toFsPath,
} from "@fdrive/core";
import { z } from "zod";
import type { Principal } from "../../auth/principal.js";
import { type McpToolDeps, runSearch, runSimilarFiles } from "../../mcp/handlers.js";
import { resolveScopeContext, virtualPathFor } from "../../mcp/scope-context.js";
import { createReadAuthorizer } from "../../scoping/read-authorizer.js";
import { toIndexRelativePath } from "../../search/scopes.js";
import { createPathLocator } from "./stored-paths.ts";
import { type AiTool, AiToolError, defineTool, formatSize } from "./tool.ts";

/**
 * The items one AI feature lets the assistant read the contents of, and how
 * the tools talk about them. Organize's focus is the selection: its folders
 * move whole, so they are never opened. Chat's focus is what the person
 * referenced, folders included.
 */
export interface ToolFocus {
  /** Normalized paths; a folder covers everything inside it. */
  readonly paths: ReadonlySet<string>;
  /** How one item is described, e.g. "selected", as in "(selected)" and "a selected file". */
  readonly adjective: string;
  /** How the set is described, e.g. "the selection", as in "outside the selection". */
  readonly group: string;
  /** Whether the folder tools open folders in the focus. */
  readonly openFolders: boolean;
}

export interface DriveToolsDeps {
  readonly mcp: McpToolDeps;
  readonly principal: Principal;
  readonly focus: ToolFocus;
  /** Whether the identity has verified index scopes, so excerpts, search and similarity can work. */
  readonly indexed: boolean;
  /** What the person chose to share with the model; defaults to everything. */
  readonly share?: OrganizeSharing | undefined;
}

/** Listings a single `folder_tree` call may make. */
export const TREE_LISTING_BUDGET = 150;
const TREE_CONCURRENCY = 8;
const TREE_SAMPLE_FILES = 6;
export const TREE_MAX_LINES = 800;
const LIST_PAGE = 200;
export const MAX_EXCERPT_PATHS = 25;
export const EXCERPT_CHARS = 1500;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function describeFile(entry: FileEntry): string {
  return `${entry.name} (${formatSize(entry.size)}, ${entry.modifiedAt.toISOString().slice(0, 10)})`;
}

function sharingOf(deps: DriveToolsDeps): OrganizeSharing {
  return deps.share ?? DEFAULT_ORGANIZE_SHARING;
}

function trashPathOf(deps: DriveToolsDeps): string | null {
  return deps.mcp.trashPathForStorage?.(deps.principal.storage) ?? deps.mcp.trashPath ?? null;
}

function inTrash(trashPath: string | null, path: string): boolean {
  return trashPath !== null && (path === trashPath || isUnderPath(trashPath, path));
}

function normalizeArg(path: string): string {
  try {
    return normalizePath(path);
  } catch {
    throw new AiToolError(`"${path}" is not a valid path.`);
  }
}

/** The stored spelling of a path the model wrote, which may encode accents differently. */
async function storedArg(deps: DriveToolsDeps, path: string): Promise<string> {
  return (await createPathLocator(deps.principal.storage).locate(normalizeArg(path))).path;
}

/** True when `path` is one of `paths` or lies inside one of its folders. */
export function isWithin(paths: ReadonlySet<string>, path: string): boolean {
  if (paths.has(path)) return true;
  for (const item of paths) if (isUnderPath(item, path)) return true;
  return false;
}

/** A folder the tools leave closed: in the focus, when the focus is closed. */
function isClosed(focus: ToolFocus, path: string): boolean {
  return !focus.openFolders && focus.paths.has(path);
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function describeListingError(error: unknown): string {
  return error instanceof Error ? error.message : "could not be listed";
}

function folderTreeTool(deps: DriveToolsDeps): AiTool {
  const schema = z.object({
    path: z.string().default("/").describe("Folder to start from. Defaults to the drive root."),
    depth: z
      .number()
      .int()
      .min(1)
      .max(4)
      .default(2)
      .describe("How many folder levels to open, 1 to 4. The level below is shown by name."),
  });
  const { otherFileNames } = sharingOf(deps);
  const { focus } = deps;
  const notOpened = focus.openFolders
    ? "Trash is not opened."
    : `${capitalize(focus.adjective)} items and Trash are not opened.`;
  return defineTool(
    "folder_tree",
    otherFileNames
      ? `Shows how the drive is organized: nested folders with their file counts and a few example file names. ${notOpened}`
      : `Shows how the drive is organized: nested folders with their file counts. File names outside ${focus.group} are not shared. ${notOpened}`,
    schema,
    {
      activity: (args) => `Looked through ${args.path}`,
      async run(args, signal) {
        const root = await storedArg(deps, args.path);
        const trashPath = trashPathOf(deps);
        if (inTrash(trashPath, root)) throw new AiToolError("That folder is the Trash.");
        const listings = new Map<string, FileEntry[] | string>();
        let frontier = isClosed(focus, root) ? [] : [root];
        let budget = TREE_LISTING_BUDGET;
        let stopped = false;
        for (let level = 0; level < args.depth && frontier.length > 0; level++) {
          const batch = frontier.slice(0, budget);
          stopped ||= batch.length < frontier.length;
          budget -= batch.length;
          await mapLimit(batch, TREE_CONCURRENCY, async (folder) => {
            signal.throwIfAborted();
            try {
              listings.set(folder, await deps.principal.storage.list(folder));
            } catch (error) {
              listings.set(folder, describeListingError(error));
            }
          });
          frontier = batch.flatMap((folder) => {
            const entries = listings.get(folder);
            return typeof entries === "string" || entries === undefined
              ? []
              : entries
                  .filter(
                    (entry) =>
                      entry.kind === "dir" &&
                      !inTrash(trashPath, entry.path) &&
                      !isClosed(focus, entry.path),
                  )
                  .map((entry) => entry.path)
                  .sort();
          });
        }

        const lines: string[] = [];
        const render = (folder: string, indent: number) => {
          if (lines.length >= TREE_MAX_LINES) return;
          const pad = "  ".repeat(indent);
          const label = folder === "/" ? "/" : `${indent === 0 ? folder : baseName(folder)}/`;
          const entries = listings.get(folder);
          const mark = focus.paths.has(folder) ? ` (${focus.adjective})` : "";
          if (isClosed(focus, folder)) {
            lines.push(`${pad}${label}${mark}`);
            return;
          }
          if (entries === undefined) {
            lines.push(`${pad}${label}${mark}`);
            return;
          }
          if (typeof entries === "string") {
            lines.push(`${pad}${label}${mark} (${entries})`);
            return;
          }
          const dirs = entries
            .filter((entry) => entry.kind === "dir" && !inTrash(trashPath, entry.path))
            .sort((a, b) => a.name.localeCompare(b.name));
          const files = entries.filter((entry) => entry.kind !== "dir");
          // Without other file names, only files in the focus are named; the count still covers every file.
          const samples = (
            otherFileNames ? files : files.filter((entry) => focus.paths.has(entry.path))
          )
            .slice(0, TREE_SAMPLE_FILES)
            .map((entry) =>
              focus.paths.has(entry.path) ? `${entry.name} (${focus.adjective})` : entry.name,
            );
          const more = files.length > samples.length ? `, … +${files.length - samples.length}` : "";
          lines.push(
            `${pad}${label}${mark} ${dirs.length} folders, ${files.length} files${samples.length > 0 ? `: ${samples.join(", ")}${more}` : ""}`,
          );
          for (const dir of dirs) render(dir.path, indent + 1);
        };
        render(root, 0);
        if (lines.length >= TREE_MAX_LINES)
          lines.push("(Output truncated; call folder_tree on a subfolder for more.)");
        else if (stopped)
          lines.push(
            `(Stopped opening folders after ${TREE_LISTING_BUDGET}; call folder_tree on a subfolder for more.)`,
          );
        return lines.join("\n");
      },
    },
  );
}

function listFolderTool(deps: DriveToolsDeps): AiTool {
  const schema = z.object({
    path: z.string().describe("Folder to list."),
    offset: z.number().int().min(0).default(0).describe("Skip this many entries, for paging."),
  });
  const { otherFileNames } = sharingOf(deps);
  const { focus } = deps;
  return defineTool(
    "list_folder",
    otherFileNames
      ? "Lists every folder and file directly inside one folder, with file sizes and modification dates."
      : `Lists every folder directly inside one folder, with ${focus.adjective} files. Other files are counted, not named.`,
    schema,
    {
      activity: (args) => `Opened ${args.path}`,
      async run(args) {
        const path = await storedArg(deps, args.path);
        const trashPath = trashPathOf(deps);
        if (inTrash(trashPath, path)) throw new AiToolError("That folder is the Trash.");
        const all = (await deps.principal.storage.list(path)).filter(
          (entry) => !inTrash(trashPath, entry.path),
        );
        const withheld = otherFileNames
          ? 0
          : all.filter((entry) => entry.kind !== "dir" && !focus.paths.has(entry.path)).length;
        const entries = all
          .filter((entry) => otherFileNames || entry.kind === "dir" || focus.paths.has(entry.path))
          .sort((a, b) =>
            a.kind === "dir" && b.kind !== "dir"
              ? -1
              : a.kind !== "dir" && b.kind === "dir"
                ? 1
                : a.name.localeCompare(b.name),
          );
        const page = entries.slice(args.offset, args.offset + LIST_PAGE);
        const lines = page.map((entry) => {
          const label = entry.kind === "dir" ? `${entry.name}/` : describeFile(entry);
          return focus.paths.has(entry.path) ? `${label} (${focus.adjective})` : label;
        });
        const header = `${path}: ${all.length} entries`;
        if (withheld > 0)
          lines.push(`(${withheld} other ${withheld === 1 ? "file" : "files"}, names not shared)`);
        const footer =
          args.offset + page.length < entries.length
            ? `\n(More: call again with offset ${args.offset + page.length}.)`
            : "";
        return `${header}\n${lines.join("\n")}${footer}`;
      },
    },
  );
}

function readExcerptsTool(deps: DriveToolsDeps): AiTool {
  const { focus } = deps;
  const schema = z.object({
    paths: z
      .array(z.string())
      .min(1)
      .max(MAX_EXCERPT_PATHS)
      .describe(
        `${capitalize(focus.adjective)} files (or files inside ${focus.adjective} folders) to read, at most 25.`,
      ),
  });
  let scope: ReturnType<typeof resolveScope> | undefined;
  function resolveScope() {
    return (async () => {
      const identity = await deps.mcp.identities.get(deps.principal.identityId);
      const verified =
        identity === null ? null : await deps.mcp.scopeResolver.verifiedIndexScopes(identity);
      if (verified === null || !verified.available) return null;
      return resolveScopeContext(deps.mcp.indexQueries, verified.scopes, trashPathOf(deps));
    })();
  }
  return defineTool(
    "read_excerpts",
    `Reads the start of each file's already-extracted text (documents, PDFs, OCR'd scans), up to ${EXCERPT_CHARS} characters each. Only works on ${focus.adjective} items.`,
    schema,
    {
      activity: (args) =>
        args.paths.length === 1
          ? `Read ${baseName(args.paths[0] as string)}`
          : `Read ${args.paths.length} files`,
      async run(args) {
        scope ??= resolveScope();
        const ctx = await scope;
        if (ctx === null) return "Extracted text is not available for this drive.";
        const authorizer = createReadAuthorizer({ storage: deps.principal.storage });
        const locator = createPathLocator(deps.principal.storage);
        const sections = await mapLimit(args.paths, 6, async (raw) => {
          let path: string;
          try {
            path = normalizePath(raw);
          } catch {
            return `### ${raw}\n(Not a valid path.)`;
          }
          path = (await locator.locate(path)).path;
          if (!isWithin(focus.paths, path))
            return `### ${raw}\n(Not a ${focus.adjective} item; only ${focus.adjective} items can be read.)`;
          const resolved = toFsPath(ctx.scopes, path);
          const rootId = resolved === null ? undefined : ctx.rootIdByName.get(resolved.rootName);
          const file =
            resolved === null || rootId === undefined
              ? null
              : await deps.mcp.indexQueries.fileByPath(
                  rootId,
                  toIndexRelativePath(resolved.fsPath),
                );
          if (file === null || virtualPathFor(ctx, file.rootId, file.path) !== path)
            return `### ${path}\n(Not indexed.)`;
          if (!(await authorizer.authorize({ path, kind: "file" })).allowed)
            return `### ${path}\n(Not indexed.)`;
          const text = (await deps.mcp.indexQueries.fileTextPrefix(file.id, EXCERPT_CHARS)).trim();
          return text.length > 0
            ? `### ${path}\n${text}`
            : `### ${path}\n(No extracted text; status: ${file.textStatus}.)`;
        });
        return sections.join("\n\n");
      },
    },
  );
}

/** Groups hits by folder so the model sees where related things live, not other files' contents. Without `names`, only counts. */
function groupByFolder(
  hits: readonly { path: string; name: string }[],
  focus: ToolFocus,
  names: boolean,
): string {
  const folders = new Map<string, string[]>();
  for (const hit of hits) {
    if (isWithin(focus.paths, hit.path)) continue;
    const folder = parentPath(hit.path);
    folders.set(folder, [...(folders.get(folder) ?? []), hit.name]);
  }
  if (folders.size === 0) return `No related files outside ${focus.group}.`;
  return [...folders.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([folder, matches]) => {
      const count = `${folder}: ${matches.length} ${matches.length === 1 ? "match" : "matches"}`;
      return names ? `${count} (${matches.slice(0, 5).join(", ")})` : count;
    })
    .join("\n");
}

function searchTool(deps: DriveToolsDeps): AiTool {
  const schema = z.object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe('Words to search for, e.g. "invoice" or "tax return".'),
  });
  return defineTool(
    "search_drive",
    "Searches file names and indexed text across the drive and reports which folders hold matching files. Use it to find where a kind of document already lives.",
    schema,
    {
      activity: (args) => `Searched for “${args.query}”`,
      async run(args) {
        const response = await runSearch(deps.mcp, deps.principal, {
          query: args.query,
          limit: 50,
        });
        if ("unavailable" in response && response.unavailable)
          return "Search is not available right now.";
        return groupByFolder(response.results, deps.focus, sharingOf(deps).otherFileNames);
      },
    },
  );
}

function similarTool(deps: DriveToolsDeps): AiTool {
  const { focus } = deps;
  const schema = z.object({
    path: z.string().describe(`A ${focus.adjective} file.`),
  });
  return defineTool(
    "similar_files",
    `Finds indexed files whose content resembles a ${focus.adjective} file and reports which folders they are in.`,
    schema,
    {
      activity: (args) => `Compared ${baseName(args.path)} with similar files`,
      async run(args) {
        const path = await storedArg(deps, args.path);
        if (!isWithin(focus.paths, path))
          throw new AiToolError(`Only ${focus.adjective} items can be compared.`);
        const response = await runSimilarFiles(deps.mcp, deps.principal, { path, limit: 20 });
        return groupByFolder(response.results, focus, sharingOf(deps).otherFileNames);
      },
    },
  );
}

/**
 * The read-only drive tools for one focus: index-backed tools only when the
 * identity is indexed, and excerpts only when the person shares contents.
 */
export function createDriveTools(deps: DriveToolsDeps): AiTool[] {
  return [
    folderTreeTool(deps),
    listFolderTool(deps),
    ...(deps.indexed
      ? [
          ...(sharingOf(deps).contents ? [readExcerptsTool(deps)] : []),
          searchTool(deps),
          similarTool(deps),
        ]
      : []),
  ];
}
