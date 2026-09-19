import { createHash } from "node:crypto";
import { baseName, extensionOf, isUnderPath, normalizePath, parentPath } from "@fdrive/core";
import { z } from "zod";
import { boundedBytes, decodeText, MAX_FILE_BYTES } from "../../mcp/content.js";
import { pageText } from "../../mcp/format.js";
import {
  fileInfoInScope,
  findFilesInScope,
  McpToolError,
  similarFilesInScope,
} from "../../mcp/handlers.js";
import {
  createIndexLookup,
  type DriveToolsDeps,
  isWithin,
  type ToolFocus,
} from "../tools/drive-tools.ts";
import { createPathLocator } from "../tools/stored-paths.ts";
import { type AiTool, AiToolError, defineTool, formatSize } from "../tools/tool.ts";

/** Characters one `read_file` call returns at most. */
export const READ_CHARS = 40_000;

/** Files whose bytes are never shown as text: their text comes from the index's extraction. */
export const DOCUMENT_EXTENSIONS =
  /\.(pdf|docx?|xlsx?|pptx?|od[tpfs]|rtf|png|jpe?g|gif|webp|tiff?|heic|heif|arw|cr[23]|nef|dng|zip|gz|tar|7z|rar|mp[34]|mov|m4[av]|wav|flac)$/i;

function shareOf(deps: DriveToolsDeps) {
  return deps.share ?? { contents: true, otherFileNames: true };
}

function trashPathOf(deps: DriveToolsDeps): string | null {
  return deps.mcp.trashPathForStorage?.(deps.principal.storage) ?? deps.mcp.trashPath ?? null;
}

function normalizeArg(path: string): string {
  try {
    return normalizePath(path);
  } catch {
    throw new AiToolError(`"${path}" is not a valid path.`);
  }
}

async function storedArg(deps: DriveToolsDeps, path: string): Promise<string> {
  return (await createPathLocator(deps.principal.storage).locate(normalizeArg(path))).path;
}

/** The stored path of a referenced item, or a tool error the model can act on. */
export async function referencedArg(deps: DriveToolsDeps, raw: string): Promise<string> {
  const path = await storedArg(deps, raw);
  const trashPath = trashPathOf(deps);
  if (trashPath !== null && (path === trashPath || isUnderPath(trashPath, path)))
    throw new AiToolError("That path is in the Trash.");
  if (!isWithin(deps.focus.paths, path))
    throw new AiToolError(
      `${path} is not ${deps.focus.adjective}; only ${deps.focus.adjective} items and their contents can be used. Ask the person to add it to the chat.`,
    );
  return path;
}

/** Downloads a whole file when it fits the byte cap, else `null`. */
export async function readBytes(
  deps: DriveToolsDeps,
  path: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; sha256: string } | null> {
  const result = await deps.principal.storage.download(path, { signal });
  if (result.contentLength !== null && result.contentLength > limit) {
    await result.body.cancel();
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = await boundedBytes(result.body, limit);
  } catch {
    return null;
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function readFileTool(deps: DriveToolsDeps): AiTool {
  const { focus } = deps;
  const schema = z.object({
    path: z
      .string()
      .describe(`A ${focus.adjective} file, or a file inside a ${focus.adjective} folder.`),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Character to continue from, when an earlier call said there was more."),
  });
  const index = createIndexLookup(deps);
  return defineTool(
    "read_file",
    `Reads a ${focus.adjective} file: the text of a text file, or the already-extracted text of a document, PDF or scan. Returns up to ${READ_CHARS} characters per call; pass offset to continue.`,
    schema,
    {
      activity: (args) => `Read ${baseName(args.path)}`,
      async run(args, signal) {
        const path = await referencedArg(deps, args.path);
        const stat = await deps.principal.storage.stat(path);
        if (stat.kind === "dir") throw new AiToolError(`${path} is a folder; list it instead.`);
        if (!DOCUMENT_EXTENSIONS.test(path) && stat.size <= MAX_FILE_BYTES) {
          const read = await readBytes(deps, path, MAX_FILE_BYTES, signal);
          const text = read === null ? null : decodeText(read.bytes);
          if (read !== null && text !== null) {
            const page = pageText(text, args.offset, READ_CHARS);
            return [
              `${path} (${page.totalChars} characters, sha256 ${read.sha256})`,
              "",
              page.slice,
              ...(page.hasMore
                ? [``, `(More: call again with offset ${args.offset + page.slice.length}.)`]
                : []),
            ].join("\n");
          }
        }
        const found = await index.file(path);
        if (found === null)
          return `${path}: no extracted text is available (the file is not indexed or cannot be read as text).`;
        const { file } = found;
        if (file.textChars === 0) return `${path}: no extracted text (status: ${file.textStatus}).`;
        const text = await deps.mcp.indexQueries.fileTextPrefix(file.id, args.offset + READ_CHARS);
        const page = pageText(text, args.offset, READ_CHARS);
        const hasMore = args.offset + page.slice.length < file.textChars;
        return [
          `${path} (${file.textChars} characters of extracted text)`,
          "",
          page.slice,
          ...(hasMore
            ? [``, `(More: call again with offset ${args.offset + page.slice.length}.)`]
            : []),
        ].join("\n");
      },
    },
  );
}

/** Groups paths by folder; without names, only counts per folder. */
function describePaths(paths: readonly string[], names: boolean): string {
  if (paths.length === 0) return "none";
  if (names) return paths.join(", ");
  const folders = new Map<string, number>();
  for (const path of paths) folders.set(parentPath(path), (folders.get(parentPath(path)) ?? 0) + 1);
  return [...folders.entries()].map(([folder, count]) => `${count} in ${folder}`).join(", ");
}

function fileInfoTool(deps: DriveToolsDeps): AiTool {
  const { focus } = deps;
  const schema = z.object({ path: z.string().describe(`A ${focus.adjective} file or folder.`) });
  const index = createIndexLookup(deps);
  return defineTool(
    "file_info",
    `Size, dates, type, tags and, for indexed files, the content hash and identical copies elsewhere, for a ${focus.adjective} file or folder.`,
    schema,
    {
      activity: (args) => `Looked at ${baseName(args.path)}`,
      async run(args) {
        const path = await referencedArg(deps, args.path);
        const stat = await deps.principal.storage.stat(path);
        const lines = [
          `${path}`,
          `kind: ${stat.kind === "dir" ? "folder" : "file"}`,
          ...(stat.kind === "dir" ? [] : [`size: ${formatSize(stat.size)} (${stat.size} bytes)`]),
          `modified: ${stat.modifiedAt?.toISOString() ?? "unknown"}`,
          ...(stat.contentType ? [`type: ${stat.contentType}`] : []),
        ];
        const metadata = deps.mcp.metadata;
        if (metadata !== undefined) {
          const [entry] = await metadata.decorate(deps.principal.identityId, [
            {
              name: baseName(path),
              path,
              kind: stat.kind === "dir" ? "dir" : "file",
              size: stat.size,
              modifiedAt: (stat.modifiedAt ?? deps.mcp.clock()).toISOString(),
              ext: extensionOf(baseName(path)),
              mime: null,
            },
          ]);
          const tagIds = new Set(entry?.meta?.tagIds ?? []);
          if (tagIds.size > 0) {
            const tags = await metadata.listTags(deps.principal.accountId);
            lines.push(
              `tags: ${tags
                .filter((tag) => tagIds.has(tag.id))
                .map((tag) => tag.name)
                .join(", ")}`,
            );
          }
          if (entry?.meta?.favorite) lines.push("favorite: yes");
        }
        if (stat.kind !== "dir") {
          const found = await index.file(path);
          if (found === null) lines.push("index: not indexed, so no content hash or copies");
          else {
            const { file, scope } = found;
            lines.push(`index: ${file.textStatus}${file.sha256 ? `, sha256 ${file.sha256}` : ""}`);
            try {
              const info = await fileInfoInScope(deps.mcp, scope.ctx, scope.authorizer, { path });
              lines.push(
                `identical copies: ${describePaths(info.identical_copies, shareOf(deps).otherFileNames)}`,
              );
            } catch (error) {
              if (!(error instanceof McpToolError)) throw error;
            }
          }
        }
        return lines.join("\n");
      },
    },
  );
}

function duplicatesTool(deps: DriveToolsDeps): AiTool {
  const { focus } = deps;
  const schema = z.object({ path: z.string().describe(`A ${focus.adjective} file.`) });
  const index = createIndexLookup(deps);
  return defineTool(
    "duplicates_of",
    `For a ${focus.adjective} file: other files with identical content, files with similar content, and files elsewhere with the same name.`,
    schema,
    {
      activity: (args) => `Looked for copies of ${baseName(args.path)}`,
      async run(args) {
        const path = await referencedArg(deps, args.path);
        const found = await index.file(path);
        if (found === null)
          return `${path} is not indexed, so its content cannot be compared. Compare names, sizes and dates instead.`;
        const { scope } = found;
        const names = shareOf(deps).otherFileNames;
        const info = await fileInfoInScope(deps.mcp, scope.ctx, scope.authorizer, { path });
        const similar = await similarFilesInScope(deps.mcp, scope.ctx, scope.authorizer, {
          path,
          limit: 10,
        });
        const sameName = await findFilesInScope(deps.mcp, scope.ctx, scope.authorizer, {
          name_contains: baseName(path),
          limit: 20,
        });
        const exact = new Set(info.identical_copies);
        const near = similar.results
          .filter((hit) => hit.path !== path && !exact.has(hit.path))
          .map(
            (hit) =>
              `${names ? hit.path : parentPath(hit.path)} (${Math.round(hit.similarity * 100)}%)`,
          );
        const named = sameName.results
          .map((hit) => hit.path)
          .filter(
            (hit) =>
              hit !== path &&
              !exact.has(hit) &&
              baseName(hit).toLowerCase() === baseName(path).toLowerCase(),
          );
        return [
          `${path}`,
          `identical content: ${describePaths(info.identical_copies, names)}`,
          `similar content: ${near.length === 0 ? "none" : near.join(", ")}`,
          `same name elsewhere: ${describePaths(named, names)}`,
        ].join("\n");
      },
    },
  );
}

/**
 * The chat's own read tools, on top of the shared drive tools: reading a
 * referenced file in full, its details, and its copies. Reading needs the
 * person to share contents; copies need the index.
 */
export function createChatReadTools(deps: DriveToolsDeps): AiTool[] {
  return [
    ...(shareOf(deps).contents ? [readFileTool(deps)] : []),
    fileInfoTool(deps),
    ...(deps.indexed ? [duplicatesTool(deps)] : []),
  ];
}

export type { ToolFocus };
