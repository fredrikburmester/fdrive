import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Principal } from "../auth/principal.js";
import { canOrganize, trashPathFor } from "./access.ts";
import { MAX_FILE_BYTES, readFile, readStoredFile } from "./content.ts";
import {
  copyPath,
  createFile,
  editFile,
  fileTags,
  listTrash,
  restorePath,
  searchImages,
  setFavorite,
  trashPath,
} from "./file-tools.ts";
import {
  type McpToolDeps,
  runCreateFolder,
  runFileInfo,
  runFindDuplicates,
  runFindFiles,
  runFolderOverview,
  runIndexStats,
  runListDirectory,
  runMovePath,
  runReadFileText,
  runRecentMoves,
  runSearch,
  runSimilarFiles,
} from "./handlers.js";

/** Wraps a handler so any error it throws (business rule or unexpected) becomes an MCP tool error rather than crashing the server. */
export function wrap<Args>(
  fn: (args: Args) => Promise<unknown>,
): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

const ORDER_BY = z.enum(["modified_desc", "modified_asc", "size_desc", "path"]);

/**
 * Registers every fdrive MCP tool on `server`, scoped to `principal`'s
 * identity. Tool names and argument shapes mirror filesai's `mcp_server.py`
 * so existing prompts and the Raycast extension keep working once
 * repointed (see docs/MCP.md). Every tool validates its own input with the
 * zod shape given to `registerTool` (the SDK rejects a mismatched call
 * before the handler ever runs) and every handler's errors are mapped to a
 * tool error by `wrap`, so a bad argument, a missing file, or a disabled
 * write tool never crashes the connection.
 */
export function registerMcpTools(server: McpServer, principal: Principal, deps: McpToolDeps): void {
  const organize = canOrganize(principal, deps.writesEnabled);
  const writeNames = new Set([
    "create_folder",
    "move_path",
    "copy_path",
    "create_file",
    "upload_file",
    "edit_file",
    "trash_path",
    "restore_path",
    "set_file_tags",
    "set_favorite",
  ]);
  const register: McpServer["registerTool"] = (name, config, handler) => {
    const write = writeNames.has(name);
    return server.registerTool(
      name,
      {
        ...config,
        annotations: {
          readOnlyHint: !write,
          destructiveHint: ["move_path", "edit_file", "trash_path", "set_file_tags"].includes(name),
          idempotentHint: !write || name === "set_favorite" || name === "set_file_tags",
          openWorldHint: false,
        },
      },
      handler,
    );
  };
  register(
    "capabilities",
    {
      title: "Token access and capabilities",
      description:
        "Show this token's login, allowed folders, permissions, limits and optional index availability. Start here when a tool is unavailable.",
      inputSchema: {},
    },
    wrap(async () => {
      let index: { available: boolean; reason?: string };
      try {
        const identity = await deps.identities.get(principal.identityId);
        index =
          identity === null
            ? { available: false, reason: "login unavailable" }
            : await deps.scopeResolver.verifiedIndexScopes(identity);
      } catch {
        index = { available: false, reason: "index mapping unavailable" };
      }
      return {
        identity_id: principal.identityId,
        access: principal.tokenAccess ?? {
          mode: "legacy",
          paths: "verified index scope for legacy operations",
        },
        organize,
        full_management: principal.tokenAccess?.mode === "full",
        index: { available: index.available, ...(index.reason ? { reason: index.reason } : {}) },
        document_extraction_configured: deps.indexerClient !== null,
        trash_configured:
          trashPathFor(deps, principal) !== null && principal.storage.trash !== undefined,
        max_file_bytes: MAX_FILE_BYTES,
        edit_concurrency:
          "SHA-256 is checked before writing. Provider contracts cannot guarantee atomic updates against other clients.",
      };
    }),
  );
  register(
    "search",
    {
      title: "Search files",
      description:
        "Hybrid search (semantic + full-text + filename) over the identity's share. Use natural " +
        'language or keywords. Optional filters: path_prefix (e.g. "Documents/Work"), ext ' +
        '(e.g. "pdf"), modified_after/modified_before (ISO dates). Returns files ranked by ' +
        "relevance with snippets and fdrive URLs. Prefer this over find_files for content or " +
        "topic questions.",
      inputSchema: {
        query: z.string().min(1).describe("Natural language or keyword query."),
        path_prefix: z
          .string()
          .optional()
          .describe('Restrict to a folder, e.g. "/Documents/Work".'),
        ext: z.string().optional().describe('File extension filter, e.g. "pdf".'),
        modified_after: z
          .string()
          .optional()
          .describe("ISO date; only files modified at or after it."),
        modified_before: z
          .string()
          .optional()
          .describe("ISO date; only files modified at or before it."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results, default 10."),
      },
    },
    wrap((args) => runSearch(deps, principal, args)),
  );

  register(
    "find_files",
    {
      title: "Find files by metadata",
      description:
        "Find files by metadata only (no content): partial name, folder prefix, extension, date " +
        "range, minimum size. order_by: modified_desc | modified_asc | size_desc | path. Good for " +
        '"what did I add last week", "all xlsx under Reports", "biggest files in Downloads".',
      inputSchema: {
        name_contains: z.string().optional(),
        path_prefix: z.string().optional(),
        ext: z.string().optional(),
        modified_after: z.string().optional(),
        modified_before: z.string().optional(),
        min_size_mb: z.number().min(0).optional(),
        order_by: ORDER_BY.optional(),
        offset: z
          .number()
          .int()
          .min(0)
          .max(10_000_000)
          .optional()
          .describe("Continue at next_offset from the previous result."),
        limit: z.number().int().min(1).max(500).optional().describe("Max results, default 50."),
      },
    },
    wrap((args) => runFindFiles(deps, principal, args)),
  );

  register(
    "list_directory",
    {
      title: "List a directory",
      description:
        "List a folder directly from storage (authoritative, includes not-yet-indexed files). " +
        'path is a virtual path from the share root; "/" (or omitted) is the root.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Virtual path, e.g. "/Documents". Defaults to the root.'),
        offset: z
          .number()
          .int()
          .min(0)
          .max(10_000_000)
          .optional()
          .describe(
            "Continue at next_offset from the previous result. Listing changes can shift pages.",
          ),
        limit: z.number().int().min(1).max(2000).optional().describe("Max entries, default 300."),
      },
    },
    wrap((args) => runListDirectory(deps, principal, args)),
  );

  register(
    "read_file_text",
    {
      title: "Read a file's text",
      description:
        "Return the text of a document (PDF, Office, txt/code, OCR'd image). Extracted live, so it " +
        "works even before indexing finishes. Use offset to page through long documents. Explicit " +
        "tokens read UTF-8 directly (4 MiB limit); PDF/Office/OCR require the optional indexer extractor.",
      inputSchema: {
        path: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        max_chars: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Default 8000, clamped to [200, 40000]."),
      },
    },
    wrap((args) => runReadFileText(deps, principal, args)),
  );

  register(
    "file_info",
    {
      title: "File metadata",
      description:
        "Metadata for one file: size, dates, hash, index status, and every other path in scope " +
        "holding an identical copy (exact duplicates).",
      inputSchema: { path: z.string().min(1) },
    },
    wrap((args) => runFileInfo(deps, principal, args)),
  );

  register(
    "find_duplicates",
    {
      title: "Find duplicate files",
      description:
        "Groups of byte-identical files (same sha256), largest waste first. Optionally restrict to " +
        "a folder prefix. Use before proposing deletions; never delete without the user confirming.",
      inputSchema: {
        path_prefix: z.string().optional(),
        min_size_mb: z.number().min(0).optional().describe("Default 1."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 40."),
      },
    },
    wrap((args) => runFindDuplicates(deps, principal, args)),
  );

  register(
    "similar_files",
    {
      title: "Find similar files",
      description:
        "Files whose content is semantically closest to the given file (e.g. other versions of the " +
        "same contract, the same slides in another folder). Requires the file to already be indexed.",
      inputSchema: {
        path: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
      },
    },
    wrap((args) => runSimilarFiles(deps, principal, args)),
  );

  register(
    "folder_overview",
    {
      title: "Folder overview",
      description:
        "Size, file count, newest modification, and top file types per sub-folder, `depth` levels " +
        "below path_prefix. Use this to understand a folder before proposing how to reorganize it.",
      inputSchema: {
        path_prefix: z.string().optional(),
        depth: z.number().int().min(1).max(4).optional().describe("Default 1."),
      },
    },
    wrap((args) => runFolderOverview(deps, principal, args)),
  );

  register(
    "index_stats",
    {
      title: "Index health",
      description:
        "Health of the index for this identity's scope: how many files are tracked, how many have " +
        "text/embeddings, and whether write tools are enabled.",
      inputSchema: {},
    },
    wrap(() => runIndexStats(deps, principal)),
  );

  if (organize) {
    register(
      "create_folder",
      {
        title: "Create a folder",
        description: "Create a folder (and parents) within this token’s allowed folders.",
        inputSchema: { path: z.string().min(1) },
      },
      wrap((args) => runCreateFolder(deps, principal, args)),
    );

    register(
      "move_path",
      {
        title: "Move or rename a path",
        description:
          "Move or rename a file or folder within the share. dst is the full new path (not a parent " +
          "folder). The index is updated in place when possible, so no re-OCR/re-embedding happens. " +
          "An occupied destination is refused. Use this only for user-requested organization.",
        inputSchema: { src: z.string().min(1), dst: z.string().min(1) },
      },
      wrap((args) => runMovePath(deps, principal, args)),
    );
  }

  register(
    "recent_moves",
    {
      title: "Recent moves",
      description:
        "Audit log of moves done through this MCP server (newest first), so a change can be " +
        "reversed.",
      inputSchema: { limit: z.number().int().min(1).max(500).optional().describe("Default 50.") },
    },
    wrap((args) => runRecentMoves(deps, principal, args)),
  );
  if (principal.tokenAccess === undefined) return;
  const path = z.string().min(1).max(4096);
  register(
    "read_file",
    {
      title: "Read original bytes",
      description:
        "Read a file as base64, with its SHA-256. Maximum 4 MiB. Use read_file_text for text and read_image for images.",
      inputSchema: { path },
    },
    wrap((args) => readFile(deps, principal, args.path)),
  );
  register(
    "read_image",
    {
      title: "Read an image",
      description:
        "Return a PNG, JPEG, GIF or WebP as MCP image content (maximum 4 MiB). Other formats can be read with read_file.",
      inputSchema: { path },
    },
    async (args) => {
      try {
        const file = await readStoredFile(deps, principal, args.path);
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime))
          throw new Error("Use read_file for this image format.");
        return {
          content: [
            { type: "image", data: file.bytes.toString("base64"), mimeType: file.mime },
            {
              type: "text",
              text: JSON.stringify({ path: file.path, url: file.url, sha256: file.sha256 }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );
  if (deps.imageSearchService !== undefined)
    register(
      "search_images",
      {
        title: "Search images",
        description:
          "Find indexed images by visual description within allowed folders. Results report partial or unavailable processing.",
        inputSchema: {
          query: z.string().min(1).max(2000),
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      wrap((args) => searchImages(deps, principal, args)),
    );
  if (deps.metadata !== undefined)
    register(
      "file_tags",
      {
        title: "File tags",
        description: "Read tags attached to one accessible file or folder.",
        inputSchema: { path },
      },
      wrap((args) => fileTags(deps, principal, args.path)),
    );
  if (!organize) return;
  register(
    "copy_path",
    {
      title: "Copy a file or folder",
      description:
        "Copy within allowed folders. Refuses an occupied destination and copying a folder inside itself.",
      inputSchema: { src: path, dst: path },
    },
    wrap((args) => copyPath(deps, principal, args)),
  );
  if (deps.metadata !== undefined) {
    register(
      "set_file_tags",
      {
        title: "Set file tags",
        description:
          "Replace the tags on one accessible file or folder. Creates missing tag names. An empty list clears its tags.",
        inputSchema: { path, names: z.array(z.string().trim().min(1).max(100)).max(50) },
      },
      wrap((args) => fileTags(deps, principal, args.path, args.names)),
    );
    register(
      "set_favorite",
      {
        title: "Set favorite",
        description: "Add or remove a file or folder from favorites.",
        inputSchema: { path, favorite: z.boolean() },
      },
      wrap((args) => setFavorite(deps, principal, args)),
    );
  }
  if (principal.tokenAccess.mode !== "full") return;
  register(
    "create_file",
    {
      title: "Create a text file",
      description: "Create UTF-8 text (maximum 4 MiB). Refuses an existing file or folder.",
      inputSchema: { path, text: z.string().max(MAX_FILE_BYTES) },
    },
    wrap((args) => createFile(deps, principal, args)),
  );
  register(
    "upload_file",
    {
      title: "Upload a file",
      description:
        "Create a file from canonical base64 (decoded maximum 4 MiB). Refuses an existing file or folder.",
      inputSchema: { path, data: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4) },
    },
    wrap((args) => createFile(deps, principal, args)),
  );
  register(
    "edit_file",
    {
      title: "Replace text contents",
      description:
        "Replace a UTF-8 file (maximum 4 MiB). Requires the SHA-256 from a prior read and rejects stale content. Other clients may race the provider's final write.",
      inputSchema: {
        path,
        text: z.string().max(MAX_FILE_BYTES),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      },
    },
    wrap((args) => editFile(deps, principal, args)),
  );
  if (trashPathFor(deps, principal) === null || principal.storage.trash === undefined) return;
  register(
    "trash_path",
    {
      title: "Move to Trash",
      description:
        "Move a file or folder to recoverable Trash. Requires user intent to remove it. Never permanently deletes.",
      inputSchema: { path },
    },
    wrap((args) => trashPath(deps, principal, args.path)),
  );
  register(
    "list_trash",
    {
      title: "List recoverable items",
      description:
        "List Trash entries whose original paths are in allowed folders. Partial means the provider scan reached its 10,000-item bound.",
      inputSchema: {
        offset: z.number().int().min(0).max(10_000).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    wrap((args) => listTrash(deps, principal, args)),
  );
  register(
    "restore_path",
    {
      title: "Restore from Trash",
      description:
        "Restore an id from list_trash to its original path or an unoccupied target. Both paths must be in allowed folders.",
      inputSchema: { id: z.string().min(1).max(4096), target: path.optional() },
    },
    wrap((args) => restorePath(deps, principal, args)),
  );
}
