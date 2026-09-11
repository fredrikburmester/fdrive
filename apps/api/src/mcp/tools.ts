import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Principal } from "../auth/principal.js";
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
  server.registerTool(
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

  server.registerTool(
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
        limit: z.number().int().min(1).max(500).optional().describe("Max results, default 50."),
      },
    },
    wrap((args) => runFindFiles(deps, principal, args)),
  );

  server.registerTool(
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
        limit: z.number().int().min(1).max(2000).optional().describe("Max entries, default 300."),
      },
    },
    wrap((args) => runListDirectory(deps, principal, args)),
  );

  server.registerTool(
    "read_file_text",
    {
      title: "Read a file's text",
      description:
        "Return the text of a document (PDF, Office, txt/code, OCR'd image). Extracted live, so it " +
        "works even before indexing finishes. Use offset to page through long documents. Requires " +
        "FDRIVE_INDEXER_URL to be configured; otherwise this tool reports an error.",
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    "create_folder",
    {
      title: "Create a folder",
      description:
        "Create a folder (and parents) on the share. Requires FDRIVE_MCP_WRITES to be enabled; " +
        "otherwise this tool reports an error explaining that writes are disabled.",
      inputSchema: { path: z.string().min(1) },
    },
    wrap((args) => runCreateFolder(deps, principal, args)),
  );

  server.registerTool(
    "move_path",
    {
      title: "Move or rename a path",
      description:
        "Move or rename a file or folder within the share. dst is the full new path (not a parent " +
        "folder). The index is updated in place when possible, so no re-OCR/re-embedding happens. " +
        "Requires FDRIVE_MCP_WRITES to be enabled. Always confirm with the user before moving; " +
        "never use this to delete.",
      inputSchema: { src: z.string().min(1), dst: z.string().min(1) },
    },
    wrap((args) => runMovePath(deps, principal, args)),
  );

  server.registerTool(
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
}
