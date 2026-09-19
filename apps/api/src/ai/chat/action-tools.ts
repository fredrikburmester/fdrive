import type { ChatActionEdits, ChatActionProposal, ChatActionResult } from "@fdrive/contracts";
import { baseName, isStorageError, isUnderPath, normalizePath, parentPath } from "@fdrive/core";
import { z } from "zod";
import { requireUnoccupiedTarget } from "../../fs/mutations.js";
import type { FsRoutesDeps } from "../../fs/routes.js";
import { moveMany, publishFsEvent, trashMany } from "../../fs/routes.js";
import { decodeText } from "../../mcp/content.js";
import type { OrganizeItem } from "../organize/agent.ts";
import { buildProposal } from "../organize/proposal.ts";
import type { DriveToolsDeps } from "../tools/drive-tools.ts";
import { AiToolError } from "../tools/tool.ts";
import { type ActionOutcome, type ActionTool, defineActionTool } from "./actions.ts";
import { DOCUMENT_EXTENSIONS, readBytes, referencedArg } from "./tools.ts";

export interface ChatActionToolsDeps extends DriveToolsDeps {
  readonly fs: Pick<FsRoutesDeps, "bus" | "clock" | "metadata">;
}

/** The most text one written file may hold. */
export const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_ACTION_ITEMS = 500;

function trashPathOf(deps: DriveToolsDeps): string | null {
  return deps.mcp.trashPathForStorage?.(deps.principal.storage) ?? deps.mcp.trashPath ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof AiToolError) return error.message;
  if (isStorageError(error)) return error.message;
  return "It failed.";
}

async function statItem(deps: DriveToolsDeps, path: string): Promise<OrganizeItem> {
  const stat = await deps.principal.storage.stat(path);
  if (stat.kind !== "dir" && stat.kind !== "file")
    throw new AiToolError(`${path} is neither a file nor a folder.`);
  return { path, kind: stat.kind, size: stat.size, modifiedAt: stat.modifiedAt ?? null };
}

function moveItemsTool(deps: ChatActionToolsDeps): ActionTool {
  const { focus } = deps;
  const schema = z.object({
    summary: z.string().max(300).describe("One sentence the person reads above the card."),
    moves: z
      .array(
        z.object({
          path: z.string().describe(`A ${focus.adjective} item's current path.`),
          destination: z
            .string()
            .describe(
              "Absolute path of the folder it should move into, e.g. /Finance/Receipts/2024.",
            ),
          reason: z.string().max(200).describe("One short sentence shown next to the item."),
        }),
      )
      .min(1)
      .max(MAX_ACTION_ITEMS),
  });
  return defineActionTool(
    "move_items",
    `Proposes moving ${focus.adjective} items into other folders. The person reviews the card, can change destinations, and applies it; nothing moves before that. Folders that do not exist yet are created on apply.`,
    schema,
    {
      activity: (args) =>
        args.moves.length === 1
          ? `Proposed moving ${baseName(args.moves[0]?.path ?? "")}`
          : `Proposed moving ${args.moves.length} items`,
      async verify(args) {
        const items: OrganizeItem[] = [];
        for (const move of args.moves) {
          const path = await referencedArg(deps, move.path);
          if (!items.some((item) => item.path === path)) items.push(await statItem(deps, path));
        }
        const proposal = await buildProposal({
          storage: deps.principal.storage,
          items,
          submission: {
            summary: args.summary,
            moves: args.moves.map((move) => ({ ...move, path: move.path })),
            unchanged: [],
          },
          trashPath: trashPathOf(deps),
        });
        if (proposal.suggestions.length === 0)
          throw new AiToolError(
            `Nothing could be proposed: ${proposal.unchanged.map((item) => `${item.path}: ${item.reason}`).join("; ")}`,
          );
        return { kind: "move", ...proposal };
      },
      async apply(proposal, edits) {
        if (proposal.kind !== "move") throw new Error("not a move proposal");
        const allowed = new Map(proposal.suggestions.map((item) => [item.path, item]));
        const chosen =
          edits?.moves ??
          proposal.suggestions
            .filter((item) => !item.conflict)
            .map((item) => ({ path: item.path, target: item.target }));
        const items = chosen.flatMap((move) => {
          const suggestion = allowed.get(move.path);
          if (suggestion === undefined) return [];
          let target: string;
          try {
            target = normalizePath(move.target);
          } catch {
            return [];
          }
          return [{ path: move.path, target }];
        });
        if (items.length === 0)
          return {
            outcome: "Nothing was moved.",
            results: [],
            toolResult: "The person kept no moves.",
          };
        const results = await moveMany(deps.fs, deps.principal, { items, createParents: true });
        const mapped: ChatActionResult[] = results.map((result) =>
          result.ok
            ? {
                path: result.path,
                ok: true,
                target: result.target,
                ...(result.warning ? { message: result.warning } : {}),
              }
            : {
                path: result.path,
                ok: false,
                target: result.target,
                message: result.error.message,
              },
        );
        const moved = mapped.filter((result) => result.ok).length;
        return {
          outcome:
            moved === mapped.length
              ? `Moved ${moved} ${moved === 1 ? "item" : "items"}.`
              : `Moved ${moved} of ${mapped.length} items.`,
          results: mapped,
          toolResult: mapped
            .map((result) =>
              result.ok
                ? `Moved ${result.path} to ${result.target}`
                : `Could not move ${result.path}: ${result.message}`,
            )
            .join("\n"),
        };
      },
    },
  );
}

function trashItemsTool(deps: ChatActionToolsDeps): ActionTool {
  const { focus } = deps;
  const schema = z.object({
    summary: z.string().max(300).describe("One sentence the person reads above the card."),
    items: z
      .array(
        z.object({
          path: z.string().describe(`A ${focus.adjective} item.`),
          reason: z.string().max(200).describe("One short sentence shown next to the item."),
        }),
      )
      .min(1)
      .max(MAX_ACTION_ITEMS),
  });
  return defineActionTool(
    "trash_items",
    `Proposes moving ${focus.adjective} items to the Trash, where the person can restore them. The person reviews the card and applies it; nothing is removed before that.`,
    schema,
    {
      activity: (args) =>
        args.items.length === 1
          ? `Proposed trashing ${baseName(args.items[0]?.path ?? "")}`
          : `Proposed trashing ${args.items.length} items`,
      async verify(args) {
        const items: { path: string; kind: "file" | "dir"; reason: string }[] = [];
        for (const item of args.items) {
          const path = await referencedArg(deps, item.path);
          if (path === "/") throw new AiToolError("The drive root cannot be trashed.");
          if (items.some((seen) => seen.path === path)) continue;
          const stat = await statItem(deps, path);
          items.push({ path, kind: stat.kind, reason: item.reason });
        }
        return { kind: "trash", summary: args.summary, items };
      },
      async apply(proposal, edits) {
        if (proposal.kind !== "trash") throw new Error("not a trash proposal");
        const chosen = new Set(edits?.paths ?? proposal.items.map((item) => item.path));
        const items = proposal.items.filter((item) => chosen.has(item.path));
        if (items.length === 0)
          return {
            outcome: "Nothing was trashed.",
            results: [],
            toolResult: "The person kept no items.",
          };
        const results = await trashMany(deps.fs, deps.principal, items);
        const mapped: ChatActionResult[] = results.map((result) =>
          result.ok
            ? { path: result.path, ok: true }
            : { path: result.path, ok: false, message: result.error?.message ?? "It failed." },
        );
        const done = mapped.filter((result) => result.ok).length;
        return {
          outcome:
            done === mapped.length
              ? `Moved ${done} ${done === 1 ? "item" : "items"} to Trash.`
              : `Moved ${done} of ${mapped.length} items to Trash.`,
          results: mapped,
          toolResult: mapped
            .map((result) =>
              result.ok
                ? `Trashed ${result.path}`
                : `Could not trash ${result.path}: ${result.message}`,
            )
            .join("\n"),
        };
      },
    },
  );
}

/** Where a new file may go: a referenced folder, inside one, or beside a referenced file. */
function besideReference(deps: DriveToolsDeps, target: string): boolean {
  const parent = parentPath(target);
  for (const path of deps.focus.paths)
    if (path === parent || isUnderPath(path, parent) || parentPath(path) === parent) return true;
  return false;
}

function assertTextName(path: string): void {
  if (DOCUMENT_EXTENSIONS.test(path))
    throw new AiToolError(
      `${path} is not a text file. Write a .md or .txt file next to it instead.`,
    );
}

async function checkWriteTarget(
  deps: ChatActionToolsDeps,
  input: { path: string; mode: "create" | "replace"; expectedSha256: string | null },
  signal: AbortSignal,
): Promise<{ path: string; sha256: string | null }> {
  let path: string;
  try {
    path = normalizePath(input.path);
  } catch {
    throw new AiToolError(`"${input.path}" is not a valid path.`);
  }
  const trashPath = trashPathOf(deps);
  if (trashPath !== null && (path === trashPath || isUnderPath(trashPath, path)))
    throw new AiToolError("That path is in the Trash.");
  assertTextName(path);
  if (input.mode === "create") {
    if (!besideReference(deps, path))
      throw new AiToolError(
        `${path} is not next to a ${deps.focus.adjective} item; new files go into a ${deps.focus.adjective} folder or beside a ${deps.focus.adjective} file.`,
      );
    await requireUnoccupiedTarget(deps.principal.storage, path);
    return { path, sha256: null };
  }
  const stored = await referencedArg(deps, path);
  const stat = await deps.principal.storage.stat(stored);
  if (stat.kind === "dir") throw new AiToolError(`${stored} is a folder.`);
  if (stat.size > MAX_WRITE_BYTES)
    throw new AiToolError(
      `${stored} is larger than ${MAX_WRITE_BYTES} bytes and cannot be replaced.`,
    );
  const read = await readBytes(deps, stored, MAX_WRITE_BYTES, signal);
  if (read === null || decodeText(read.bytes) === null)
    throw new AiToolError(`${stored} is not a UTF-8 text file and cannot be replaced.`);
  if (input.expectedSha256 === null)
    throw new AiToolError("Read the file first and pass the sha256 it reported.");
  if (read.sha256 !== input.expectedSha256)
    throw new AiToolError(
      `${stored} changed since it was read (sha256 ${read.sha256}). Read it again.`,
    );
  return { path: stored, sha256: read.sha256 };
}

function writeTextFileTool(deps: ChatActionToolsDeps): ActionTool {
  const { focus } = deps;
  const schema = z.object({
    summary: z.string().max(300).describe("One sentence the person reads above the card."),
    path: z
      .string()
      .describe(
        `For create: the new file's path, next to a ${focus.adjective} item. For replace: the ${focus.adjective} text file.`,
      ),
    mode: z.enum(["create", "replace"]),
    text: z.string().max(MAX_WRITE_BYTES).describe("The whole file's new content."),
    expected_sha256: z
      .string()
      .optional()
      .describe(
        "For replace: the sha256 read_file reported, so an edited file is never overwritten.",
      ),
  });
  return defineActionTool(
    "write_text_file",
    `Proposes writing a UTF-8 text file: a new .md or .txt file next to a ${focus.adjective} item, or a new version of a ${focus.adjective} text file. The person sees the text (or a diff) and applies it; nothing is written before that. Other formats cannot be written; offer a .md or .txt next to them.`,
    schema,
    {
      activity: (args) =>
        `${args.mode === "create" ? "Drafted" : "Rewrote"} ${baseName(args.path)}`,
      async verify(args, signal) {
        const target = await checkWriteTarget(
          deps,
          { path: args.path, mode: args.mode, expectedSha256: args.expected_sha256 ?? null },
          signal,
        );
        return {
          kind: "write",
          summary: args.summary,
          path: target.path,
          mode: args.mode,
          text: args.text,
          expectedSha256: target.sha256,
        };
      },
      async apply(proposal, edits, signal) {
        if (proposal.kind !== "write") throw new Error("not a write proposal");
        const mode = edits?.mode ?? proposal.mode;
        const rawPath = edits?.path ?? proposal.path;
        let path: string;
        try {
          ({ path } = await checkWriteTarget(
            deps,
            {
              path: rawPath,
              mode,
              expectedSha256:
                mode === "replace" && rawPath === proposal.path ? proposal.expectedSha256 : null,
            },
            signal,
          ));
        } catch (error) {
          const message = errorMessage(error);
          return {
            outcome: message,
            results: [{ path: rawPath, ok: false, message }],
            toolResult: `Could not write ${rawPath}: ${message}`,
          };
        }
        const bytes = Buffer.from(proposal.text, "utf8");
        try {
          await deps.principal.storage.upload(path, bytes, {
            overwrite: mode === "replace",
            contentLength: bytes.length,
            signal,
          });
        } catch (error) {
          const message = errorMessage(error);
          return {
            outcome: message,
            results: [{ path, ok: false, message }],
            toolResult: `Could not write ${path}: ${message}`,
          };
        }
        publishFsEvent(deps.fs, deps.principal, mode === "create" ? "create" : "update", [path]);
        const outcome = `${mode === "create" ? "Created" : "Replaced"} ${path}.`;
        return { outcome, results: [{ path, ok: true, target: path }], toolResult: outcome };
      },
    },
  );
}

/**
 * The chat's write tools. Trash is only offered where the login's storage
 * has a configured Trash, so nothing a chat proposes is unrecoverable.
 */
export function createChatActionTools(deps: ChatActionToolsDeps): ActionTool[] {
  const trashable = deps.principal.storage.trash !== undefined && trashPathOf(deps) !== null;
  return [
    moveItemsTool(deps),
    ...(trashable ? [trashItemsTool(deps)] : []),
    writeTextFileTool(deps),
  ];
}

export type { ActionOutcome, ActionTool, ChatActionEdits, ChatActionProposal };
