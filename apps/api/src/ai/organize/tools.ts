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
import type { AiToolSpec } from "../model.ts";

/** A tool the organizer can call. Every tool only reads; moving is the person's decision. */
export interface OrganizeTool<T = unknown> {
  readonly spec: AiToolSpec;
  readonly schema: z.ZodType<T>;
  /** One short step for the run's activity list. */
  activity(args: T): string;
  run(args: T, signal: AbortSignal): Promise<string>;
}

/** An error whose message is returned to the model as the tool result. */
export class OrganizeToolError extends Error {}

export interface OrganizeToolsDeps {
  readonly mcp: McpToolDeps;
  readonly principal: Principal;
  /** Normalized paths of the selected items. */
  readonly selected: ReadonlySet<string>;
  /** Whether the identity has verified index scopes, so excerpts, search and similarity can work. */
  readonly indexed: boolean;
}

/** Listings a single `folder_tree` call may make. */
export const TREE_LISTING_BUDGET = 150;
const TREE_CONCURRENCY = 8;
const TREE_SAMPLE_FILES = 6;
export const TREE_MAX_LINES = 800;
const LIST_PAGE = 200;
export const MAX_EXCERPT_PATHS = 25;
export const EXCERPT_CHARS = 1500;

export function toolSpec(name: string, description: string, schema: z.ZodType): AiToolSpec {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema, { io: "input" });
  return { name, description, inputSchema };
}

export function defineTool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  handlers: Pick<OrganizeTool<T>, "activity" | "run">,
): OrganizeTool {
  return { spec: toolSpec(name, description, schema), schema, ...handlers } as OrganizeTool;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function describeFile(entry: FileEntry): string {
  return `${entry.name} (${formatSize(entry.size)}, ${entry.modifiedAt.toISOString().slice(0, 10)})`;
}

function trashPathOf(deps: OrganizeToolsDeps): string | null {
  return deps.mcp.trashPathForStorage?.(deps.principal.storage) ?? deps.mcp.trashPath ?? null;
}

function inTrash(trashPath: string | null, path: string): boolean {
  return trashPath !== null && (path === trashPath || isUnderPath(trashPath, path));
}

function normalizeArg(path: string): string {
  try {
    return normalizePath(path);
  } catch {
    throw new OrganizeToolError(`"${path}" is not a valid path.`);
  }
}

/** True when `path` is a selected item or lies inside a selected folder. */
export function isSelectedOrInside(selected: ReadonlySet<string>, path: string): boolean {
  if (selected.has(path)) return true;
  for (const item of selected) if (isUnderPath(item, path)) return true;
  return false;
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

function folderTreeTool(deps: OrganizeToolsDeps): OrganizeTool {
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
  return defineTool(
    "folder_tree",
    "Shows how the drive is organized: nested folders with their file counts and a few example file names. Selected items and Trash are not opened.",
    schema,
    {
      activity: (args) => `Looked through ${args.path}`,
      async run(args, signal) {
        const root = normalizeArg(args.path);
        const trashPath = trashPathOf(deps);
        if (inTrash(trashPath, root)) throw new OrganizeToolError("That folder is the Trash.");
        const listings = new Map<string, FileEntry[] | string>();
        let frontier = deps.selected.has(root) ? [] : [root];
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
                      !deps.selected.has(entry.path),
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
          if (deps.selected.has(folder)) {
            lines.push(`${pad}${label} (selected)`);
            return;
          }
          if (entries === undefined) {
            lines.push(`${pad}${label}`);
            return;
          }
          if (typeof entries === "string") {
            lines.push(`${pad}${label} (${entries})`);
            return;
          }
          const dirs = entries
            .filter((entry) => entry.kind === "dir" && !inTrash(trashPath, entry.path))
            .sort((a, b) => a.name.localeCompare(b.name));
          const files = entries.filter((entry) => entry.kind !== "dir");
          const samples = files
            .slice(0, TREE_SAMPLE_FILES)
            .map((entry) =>
              deps.selected.has(entry.path) ? `${entry.name} (selected)` : entry.name,
            );
          const more = files.length > samples.length ? `, … +${files.length - samples.length}` : "";
          lines.push(
            `${pad}${label} ${dirs.length} folders, ${files.length} files${samples.length > 0 ? `: ${samples.join(", ")}${more}` : ""}`,
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

function listFolderTool(deps: OrganizeToolsDeps): OrganizeTool {
  const schema = z.object({
    path: z.string().describe("Folder to list."),
    offset: z.number().int().min(0).default(0).describe("Skip this many entries, for paging."),
  });
  return defineTool(
    "list_folder",
    "Lists every folder and file directly inside one folder, with file sizes and modification dates.",
    schema,
    {
      activity: (args) => `Opened ${args.path}`,
      async run(args) {
        const path = normalizeArg(args.path);
        const trashPath = trashPathOf(deps);
        if (inTrash(trashPath, path)) throw new OrganizeToolError("That folder is the Trash.");
        const entries = (await deps.principal.storage.list(path))
          .filter((entry) => !inTrash(trashPath, entry.path))
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
          return deps.selected.has(entry.path) ? `${label} (selected)` : label;
        });
        const header = `${path}: ${entries.length} entries`;
        const footer =
          args.offset + page.length < entries.length
            ? `\n(More: call again with offset ${args.offset + page.length}.)`
            : "";
        return `${header}\n${lines.join("\n")}${footer}`;
      },
    },
  );
}

function readExcerptsTool(deps: OrganizeToolsDeps): OrganizeTool {
  const schema = z.object({
    paths: z
      .array(z.string())
      .min(1)
      .max(MAX_EXCERPT_PATHS)
      .describe("Selected files (or files inside selected folders) to read, at most 25."),
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
    `Reads the start of each file's already-extracted text (documents, PDFs, OCR'd scans), up to ${EXCERPT_CHARS} characters each. Only works on selected items.`,
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
        const sections = await mapLimit(args.paths, 6, async (raw) => {
          let path: string;
          try {
            path = normalizePath(raw);
          } catch {
            return `### ${raw}\n(Not a valid path.)`;
          }
          if (!isSelectedOrInside(deps.selected, path))
            return `### ${raw}\n(Not a selected item; only selected items can be read.)`;
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

/** Groups hits by folder so the model sees where related things live, not other files' contents. */
function groupByFolder(
  hits: readonly { path: string; name: string }[],
  selected: ReadonlySet<string>,
): string {
  const folders = new Map<string, string[]>();
  for (const hit of hits) {
    if (isSelectedOrInside(selected, hit.path)) continue;
    const folder = parentPath(hit.path);
    folders.set(folder, [...(folders.get(folder) ?? []), hit.name]);
  }
  if (folders.size === 0) return "No related files outside the selection.";
  return [...folders.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([folder, names]) =>
        `${folder}: ${names.length} ${names.length === 1 ? "match" : "matches"} (${names.slice(0, 5).join(", ")})`,
    )
    .join("\n");
}

function searchTool(deps: OrganizeToolsDeps): OrganizeTool {
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
        return groupByFolder(response.results, deps.selected);
      },
    },
  );
}

function similarTool(deps: OrganizeToolsDeps): OrganizeTool {
  const schema = z.object({
    path: z.string().describe("A selected file."),
  });
  return defineTool(
    "similar_files",
    "Finds indexed files whose content resembles a selected file and reports which folders they are in.",
    schema,
    {
      activity: (args) => `Compared ${baseName(args.path)} with similar files`,
      async run(args) {
        const path = normalizeArg(args.path);
        if (!isSelectedOrInside(deps.selected, path))
          throw new OrganizeToolError("Only selected items can be compared.");
        const response = await runSimilarFiles(deps.mcp, deps.principal, { path, limit: 20 });
        return groupByFolder(response.results, deps.selected);
      },
    },
  );
}

/** The read-only tools for one organize run; index-backed tools only when the identity is indexed. */
export function createOrganizeTools(deps: OrganizeToolsDeps): OrganizeTool[] {
  return [
    folderTreeTool(deps),
    listFolderTool(deps),
    ...(deps.indexed ? [readExcerptsTool(deps), searchTool(deps), similarTool(deps)] : []),
  ];
}
