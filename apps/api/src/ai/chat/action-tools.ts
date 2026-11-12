import type {
  ChatActionEdits,
  ChatActionProposal,
  ChatActionResult,
  MoveManyResult,
} from "@fdrive/contracts";
import {
  baseName,
  changeBaseName,
  isSafeSegment,
  isStorageError,
  isUnderPath,
  normalizePath,
  parentPath,
} from "@fdrive/core";
import { z } from "zod";
import type { ActivityCallContext } from "../../activity/fs-context.js";
import { recordActivity } from "../../activity/fs-context.js";
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
  readonly fs: Pick<
    FsRoutesDeps,
    "bus" | "clock" | "metadata" | "activity" | "trashPathForStorage"
  >;
  /** The chat whose proposal the person approved, recorded with every action it applies. */
  readonly conversationId: string;
}

/**
 * Provenance for anything the person approves in chat. The account is acting,
 * with the model as the tool, so the conversation is recorded rather than an
 * actor of its own.
 */
function activityContext(deps: ChatActionToolsDeps): ActivityCallContext {
  return { source: "ai", conversationId: deps.conversationId };
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
        const results = await moveMany(
          deps.fs,
          deps.principal,
          { items, createParents: true },
          activityContext(deps),
        );
        const mapped = movedResults(results);
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
        const results = await trashMany(deps.fs, deps.principal, items, activityContext(deps));
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

/** A name the model or the person typed, as one usable path segment. */
function cleanName(raw: string): string | null {
  const name = raw.trim();
  return isSafeSegment(name) ? name : null;
}

/** Whether the item already reads as `name`; macOS stores accents as separate marks, models write one character. */
function alreadyNamed(path: string, name: string): boolean {
  return baseName(path).normalize("NFC") === name.normalize("NFC");
}

function movedResults(results: readonly MoveManyResult[]): ChatActionResult[] {
  return results.map((result) =>
    result.ok
      ? {
          path: result.path,
          ok: true,
          target: result.target,
          ...(result.warning ? { message: result.warning } : {}),
        }
      : { path: result.path, ok: false, target: result.target, message: result.error.message },
  );
}

async function occupied(storage: DriveToolsDeps["principal"]["storage"], target: string) {
  try {
    await requireUnoccupiedTarget(storage, target);
    return false;
  } catch (error) {
    if (isStorageError(error) && error.kind === "conflict") return true;
    throw error;
  }
}

/** A rename keeps its folder, so the only way into the Trash is taking the Trash folder's own name. */
function isTrashPath(deps: DriveToolsDeps, target: string): boolean {
  const trashPath = trashPathOf(deps);
  return trashPath !== null && (target === trashPath || isUnderPath(trashPath, target));
}

function depth(path: string): number {
  return path.split("/").length;
}

function renameItemsTool(deps: ChatActionToolsDeps): ActionTool {
  const { focus } = deps;
  const schema = z.object({
    summary: z.string().max(300).describe("One sentence the person reads above the card."),
    renames: z
      .array(
        z.object({
          path: z.string().describe(`A ${focus.adjective} item's current path.`),
          name: z
            .string()
            .describe(
              "Its new name only, without a folder, e.g. 2024-03 Invoice Acme.pdf. Keep a file's extension unless the person asked to change it.",
            ),
          reason: z.string().max(200).describe("One short sentence shown next to the item."),
        }),
      )
      .min(1)
      .max(MAX_ACTION_ITEMS),
  });
  return defineActionTool(
    "rename_items",
    `Proposes new names for ${focus.adjective} files and folders; each stays in its folder. The person reviews the card, can change the names, and applies it; nothing is renamed before that. A name that is already taken in the folder is marked and left out unless the person picks another.`,
    schema,
    {
      activity: (args) =>
        args.renames.length === 1
          ? `Proposed renaming ${baseName(args.renames[0]?.path ?? "")}`
          : `Proposed renaming ${args.renames.length} items`,
      async verify(args) {
        const items: Extract<ChatActionProposal, { kind: "rename" }>["items"] = [];
        const targets = new Set<string>();
        for (const rename of args.renames) {
          const path = await referencedArg(deps, rename.path);
          if (path === "/") throw new AiToolError("The drive root cannot be renamed.");
          if (items.some((seen) => seen.path === path)) continue;
          const name = cleanName(rename.name);
          if (name === null)
            throw new AiToolError(
              `"${rename.name}" is not a usable name for ${path}: give a name without "/", not a path.`,
            );
          if (alreadyNamed(path, name)) continue;
          const target = changeBaseName(path, name);
          if (isTrashPath(deps, target))
            throw new AiToolError(`${path} cannot be named ${name}: that is the Trash.`);
          const stat = await statItem(deps, path);
          const conflict = targets.has(target) || (await occupied(deps.principal.storage, target));
          targets.add(target);
          items.push({ path, kind: stat.kind, name, reason: rename.reason, conflict });
        }
        if (items.length === 0)
          throw new AiToolError("Nothing to rename: every item already has the proposed name.");
        return { kind: "rename", summary: args.summary, items };
      },
      async apply(proposal, edits) {
        if (proposal.kind !== "rename") throw new Error("not a rename proposal");
        const allowed = new Set(proposal.items.map((item) => item.path));
        const chosen =
          edits?.renames ??
          proposal.items
            .filter((item) => !item.conflict)
            .map((item) => ({ path: item.path, name: item.name }));
        const invalid: ChatActionResult[] = [];
        const items: { path: string; target: string }[] = [];
        for (const rename of chosen) {
          if (!allowed.has(rename.path) || items.some((item) => item.path === rename.path))
            continue;
          const name = cleanName(rename.name);
          if (name === null || isTrashPath(deps, changeBaseName(rename.path, name)))
            invalid.push({
              path: rename.path,
              ok: false,
              message: `"${rename.name}" is not a usable name.`,
            });
          else if (!alreadyNamed(rename.path, name))
            items.push({ path: rename.path, target: changeBaseName(rename.path, name) });
        }
        if (items.length === 0 && invalid.length === 0)
          return {
            outcome: "Nothing was renamed.",
            results: [],
            toolResult: "The person kept no renames.",
          };
        // Deepest first, so renaming a folder never strands a rename of something inside it.
        items.sort((a, b) => depth(b.path) - depth(a.path));
        const results =
          items.length === 0
            ? []
            : await moveMany(
                deps.fs,
                deps.principal,
                { items },
                activityContext(deps),
                "file.rename",
              );
        const mapped = [...movedResults(results), ...invalid];
        const renamed = mapped.filter((result) => result.ok).length;
        return {
          outcome:
            renamed === mapped.length
              ? `Renamed ${renamed} ${renamed === 1 ? "item" : "items"}.`
              : `Renamed ${renamed} of ${mapped.length} items.`,
          results: mapped,
          toolResult: mapped
            .map((result) =>
              result.ok
                ? `Renamed ${result.path} to ${result.target}`
                : `Could not rename ${result.path}: ${result.message}`,
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
          await recordActivity(
            deps.fs.activity,
            deps.principal,
            {
              ...activityContext(deps),
              action: mode === "create" ? "file.create" : "file.save",
              requested: { path, kind: "file", conversationId: deps.conversationId },
            },
            () =>
              deps.principal.storage.upload(path, bytes, {
                overwrite: mode === "replace",
                contentLength: bytes.length,
                signal,
              }),
            () => ({ path, kind: "file", size: bytes.length }),
          );
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

/** The tool that applies each kind of card. */
export const ACTION_TOOL_NAMES: Record<ChatActionProposal["kind"], string> = {
  move: "move_items",
  rename: "rename_items",
  trash: "trash_items",
  write: "write_text_file",
};

/**
 * The chat's write tools. Trash is only offered where the login's storage
 * has a configured Trash, so nothing a chat proposes is unrecoverable.
 */
export function createChatActionTools(deps: ChatActionToolsDeps): ActionTool[] {
  const trashable = deps.principal.storage.trash !== undefined && trashPathOf(deps) !== null;
  return [
    moveItemsTool(deps),
    renameItemsTool(deps),
    ...(trashable ? [trashItemsTool(deps)] : []),
    writeTextFileTool(deps),
  ];
}

export type { ActionOutcome, ActionTool, ChatActionEdits, ChatActionProposal };
