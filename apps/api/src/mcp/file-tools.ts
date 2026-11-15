import { createHash } from "node:crypto";
import { extensionOf, isTrashId, TRASH_PATH } from "@fdrive/core";
import { recordMetadataCommand } from "../activity/metadata.js";
import type { TokenPrincipal } from "../tokens/principal.ts";
import {
  assertMutablePath,
  canReadPath,
  containsPath,
  ordinaryPath,
  requireMode,
  tokenScopes,
} from "./access.ts";
import { decodeText, liveFileInfo, MAX_FILE_BYTES, readStoredFile } from "./content.ts";
import { type McpToolDeps, McpToolError, mcpFiles, warningsOf } from "./handlers.ts";
import { fileUrl, folderUrl } from "./urls.ts";

function checkedBytes(bytes: Buffer): Buffer {
  if (bytes.length > MAX_FILE_BYTES)
    throw new Error(`content exceeds the ${MAX_FILE_BYTES} byte limit`);
  return bytes;
}

export async function createFile(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: { path: string; text?: string; data?: string },
) {
  requireMode(principal, "full");
  const path = ordinaryPath(principal, args.path);
  const bytes = checkedBytes(
    args.text !== undefined
      ? Buffer.from(args.text, "utf8")
      : Buffer.from(args.data ?? "", "base64"),
  );
  if (args.data !== undefined && bytes.toString("base64") !== args.data)
    throw new Error("data must be canonical base64");
  const publicUrl = await deps.publicUrl();
  const { files, actor } = mcpFiles(deps, principal);
  const done = await files.upload(actor, path, bytes, {
    action: args.data === undefined ? "file.create" : "file.upload",
    overwrite: false,
    contentLength: bytes.length,
    signal: AbortSignal.timeout(30_000),
  });
  return {
    created: path,
    url: fileUrl(publicUrl, path),
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...warningsOf(done),
  };
}

// Serialize MCP edits for the same login/path in this API process. The provider's
// write contract still cannot guard against other processes or external clients.
const editing = new Map<string, Promise<void>>();
export async function editFile(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: { path: string; text: string; expected_sha256: string },
) {
  requireMode(principal, "full");
  const path = ordinaryPath(principal, args.path);
  const key = JSON.stringify([principal.identityId, path]);
  const prior = editing.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  editing.set(key, current);
  await prior;
  try {
    return await editFileUnlocked(deps, principal, { ...args, path });
  } finally {
    if (editing.get(key) === current) editing.delete(key);
    release();
  }
}

async function editFileUnlocked(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: { path: string; text: string; expected_sha256: string },
) {
  requireMode(principal, "full");
  const bytes = checkedBytes(Buffer.from(args.text, "utf8"));
  const previous = await readStoredFile(deps, principal, args.path);
  if (previous.sha256 !== args.expected_sha256)
    throw new Error("file changed since it was read; read it again before editing");
  if (
    decodeText(previous.bytes) === null ||
    /\.(pdf|docx?|xlsx?|pptx?|od[tpfs]|png|jpe?g|webp|tiff?|heic|heif)$/i.test(previous.path)
  ) {
    throw new Error("edit_file only replaces UTF-8 text files");
  }
  const { files, actor } = mcpFiles(deps, principal);
  const done = await files.upload(actor, previous.path, bytes, {
    action: "file.save",
    overwrite: true,
    contentLength: bytes.length,
    signal: AbortSignal.timeout(30_000),
  });
  return {
    updated: previous.path,
    url: previous.url,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...warningsOf(done),
  };
}

export async function copyPath(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: { src: string; dst: string },
) {
  requireMode(principal, "organize");
  const src = ordinaryPath(principal, args.src);
  const dst = ordinaryPath(principal, args.dst);
  if (containsPath(src, TRASH_PATH)) throw new Error("cannot copy a folder containing Trash");
  const publicUrl = await deps.publicUrl();
  const { files, actor } = mcpFiles(deps, principal);
  const { entry } = await files.copy(actor, src, dst);
  return {
    copied: src,
    to: dst,
    url: entry.kind === "dir" ? folderUrl(publicUrl, dst) : fileUrl(publicUrl, dst),
  };
}

/** Moves `rawPath` to Trash, as the web's delete does. */
export async function trashPath(deps: McpToolDeps, principal: TokenPrincipal, rawPath: string) {
  requireMode(principal, "full");
  const path = ordinaryPath(principal, rawPath);
  assertMutablePath(principal, path);
  const { files, actor } = mcpFiles(deps, principal);
  const done = await files.trash(actor, path);
  return { trashed: path, ...warningsOf(done) };
}

/** What Trash holds, for the Trash tools; `file changes are unavailable` without it. */
function requireTrash(deps: McpToolDeps) {
  if (deps.trash === undefined) throw new McpToolError("file changes are unavailable");
  return deps.trash;
}

export async function listTrash(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: { offset?: number | undefined; limit?: number | undefined },
) {
  requireMode(principal, "full");
  const listing = await requireTrash(deps).list(principal.identityId, 10_000);
  const entries = listing.items
    .filter((entry) => canReadPath(principal, entry.originalPath))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offset = args.offset ?? 0;
  const end = offset + (args.limit ?? 100);
  return {
    entries: entries.slice(offset, end).map((entry) => ({
      id: entry.id,
      originalPath: entry.originalPath,
      name: entry.name,
      size: entry.size,
      deletedAt: entry.deletedAt.toISOString(),
    })),
    partial: listing.truncated,
    ...(end < entries.length ? { next_offset: end } : {}),
  };
}

export async function restorePath(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: { id: string; target?: string | undefined },
) {
  requireMode(principal, "full");
  const item = isTrashId(args.id)
    ? await requireTrash(deps).get(principal.identityId, args.id)
    : null;
  if (item === null) throw new McpToolError("not a Trash item id");
  const original = ordinaryPath(principal, item.originalPath);
  const target = ordinaryPath(principal, args.target ?? original);
  const publicUrl = await deps.publicUrl();
  const { files, actor } = mcpFiles(deps, principal);
  const done = await files.restore(actor, args.id, target);
  const result = done.entry;
  return {
    restored: result.path,
    url:
      result.kind === "dir" ? folderUrl(publicUrl, result.path) : fileUrl(publicUrl, result.path),
    ...warningsOf(done),
  };
}

function requireMetadata(deps: McpToolDeps) {
  if (deps.metadata === undefined) throw new Error("file metadata is unavailable");
  return deps.metadata;
}

export async function fileTags(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  rawPath: string,
  names?: string[],
) {
  if (names !== undefined) requireMode(principal, "organize");
  const info = await liveFileInfo(deps, principal, rawPath);
  const metadata = requireMetadata(deps);
  let tags = await metadata.listTags(principal.accountId);
  if (names !== undefined) {
    const selected: typeof tags = [];
    for (const name of new Set(names)) {
      const tag =
        tags.find((tag) => tag.name === name) ??
        (await metadata.createTag(principal.accountId, { name, color: null }));
      selected.push(tag);
    }
    await recordMetadataCommand(
      deps.activity,
      principal,
      metadata,
      {
        action: "file.tags.set",
        source: "mcp",
        ...(deps.activityRequestId
          ? { producerOperationId: `${deps.activityContext}:${deps.activityRequestId}:tags` }
          : {}),
        requested: { path: info.path, tags: selected },
      },
      (metadata) =>
        metadata.setFileTags(
          principal,
          info.path,
          selected.map((tag) => tag.id),
        ),
    );
    tags = selected;
  } else {
    const [entry] = await metadata.decorate(principal.identityId, [
      {
        path: info.path,
        name: info.name,
        kind: info.kind,
        size: info.size_bytes,
        modifiedAt: info.modified,
        mime: info.mime,
        ext: extensionOf(info.name),
      },
    ]);
    tags = tags.filter((tag) => entry?.meta?.tagIds.includes(tag.id));
  }
  return { path: info.path, tags };
}

export async function setFavorite(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: { path: string; favorite: boolean },
) {
  requireMode(principal, "organize");
  const info = await liveFileInfo(deps, principal, args.path);
  const metadata = requireMetadata(deps);
  if (info.kind !== "file" && info.kind !== "dir")
    throw new Error("only files and folders can be favorites");
  const kind = info.kind;
  await recordMetadataCommand(
    deps.activity,
    principal,
    metadata,
    {
      action: "file.favorite.set",
      source: "mcp",
      ...(deps.activityRequestId
        ? { producerOperationId: `${deps.activityContext}:${deps.activityRequestId}:favorite` }
        : {}),
      requested: { path: info.path, kind, favorite: args.favorite },
    },
    (metadata) =>
      args.favorite
        ? metadata.addFavorite(principal.identityId, info.path, kind)
        : metadata.removeFavorite(principal.identityId, info.path),
  );
  return { path: info.path, favorite: args.favorite };
}

export async function searchImages(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: { query: string; limit?: number | undefined },
) {
  if (deps.imageSearchService === undefined)
    return { query: args.query, hits: [], unavailable: true };
  const scopes = (await deps.indexed())
    ? tokenScopes(principal, await deps.scopeResolver.scopesFor(principal.username))
    : [];
  const response = await deps.imageSearchService.search({
    query: args.query,
    limit: args.limit ?? 20,
    scopes,
  });
  const publicUrl = await deps.publicUrl();
  return {
    ...response,
    hits: response.hits.map((hit) => ({ ...hit, url: fileUrl(publicUrl, hit.path) })),
  };
}
