import { createHash } from "node:crypto";
import { extensionOf, isStorageError, trashLeafPath } from "@fdrive/core";
import { recordMetadataCommand } from "../activity/metadata.js";
import type { Principal } from "../auth/principal.ts";
import { relocatePath, requireUnoccupiedTarget } from "../fs/mutations.ts";
import { createReadAuthorizer } from "../scoping/read-authorizer.ts";
import {
  assertMutablePath,
  canReadPath,
  containsPath,
  ordinaryPath,
  requireExplicitAccess,
  requireMode,
  tokenScopes,
  trashPathFor,
} from "./access.ts";
import { decodeText, liveFileInfo, MAX_FILE_BYTES, readStoredFile } from "./content.ts";
import type { McpToolDeps } from "./handlers.ts";
import { fileUrl, folderUrl } from "./urls.ts";

async function mutationEffects(
  deps: McpToolDeps,
  principal: Principal,
  change: Parameters<NonNullable<McpToolDeps["onMutation"]>>[1],
) {
  try {
    await deps.onMutation?.(principal, change);
    return {};
  } catch {
    return {
      warnings: ["Storage operation completed, but metadata or live updates could not be updated."],
    };
  }
}

function checkedBytes(bytes: Buffer): Buffer {
  if (bytes.length > MAX_FILE_BYTES)
    throw new Error(`content exceeds the ${MAX_FILE_BYTES} byte limit`);
  return bytes;
}

export async function createFile(
  deps: McpToolDeps,
  principal: Principal,
  args: { path: string; text?: string; data?: string },
) {
  requireMode(principal, "full");
  const path = ordinaryPath(deps, principal, args.path);
  const bytes = checkedBytes(
    args.text !== undefined
      ? Buffer.from(args.text, "utf8")
      : Buffer.from(args.data ?? "", "base64"),
  );
  if (args.data !== undefined && bytes.toString("base64") !== args.data)
    throw new Error("data must be canonical base64");
  await requireUnoccupiedTarget(principal.storage, path);
  const publicUrl = await deps.publicUrl();
  await principal.storage.upload(path, bytes, {
    overwrite: false,
    contentLength: bytes.length,
    signal: AbortSignal.timeout(30_000),
  });
  return {
    created: path,
    url: fileUrl(publicUrl, path),
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(await mutationEffects(deps, principal, { kind: "create", path, isDir: false })),
  };
}

// Serialize MCP edits for the same login/path in this API process. The provider's
// write contract still cannot guard against other processes or external clients.
const editing = new Map<string, Promise<void>>();
export async function editFile(
  deps: McpToolDeps,
  principal: Principal,
  args: { path: string; text: string; expected_sha256: string },
) {
  requireMode(principal, "full");
  const path = ordinaryPath(deps, principal, args.path);
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
  principal: Principal,
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
  await principal.storage.upload(previous.path, bytes, {
    contentLength: bytes.length,
    signal: AbortSignal.timeout(30_000),
  });
  return {
    updated: previous.path,
    url: previous.url,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(await mutationEffects(deps, principal, {
      kind: "create",
      path: previous.path,
      isDir: false,
    })),
  };
}

export async function copyPath(
  deps: McpToolDeps,
  principal: Principal,
  args: { src: string; dst: string },
) {
  requireExplicitAccess(principal);
  requireMode(principal, "organize");
  const src = ordinaryPath(deps, principal, args.src);
  const dst = ordinaryPath(deps, principal, args.dst);
  const trashPath = trashPathFor(deps, principal);
  if (trashPath !== null && containsPath(src, trashPath))
    throw new Error("cannot copy a folder containing Trash");
  const stat = await principal.storage.stat(src);
  const publicUrl = await deps.publicUrl();
  await relocatePath(principal.storage, "copy", src, dst);
  return {
    copied: src,
    to: dst,
    url: stat.kind === "dir" ? folderUrl(publicUrl, dst) : fileUrl(publicUrl, dst),
    ...(src === dst
      ? {}
      : await mutationEffects(deps, principal, {
          kind: "copy",
          path: src,
          target: dst,
          isDir: stat.kind === "dir",
        })),
  };
}

function requireTrash(deps: McpToolDeps, principal: Principal) {
  requireMode(principal, "full");
  const path = trashPathFor(deps, principal);
  const trash = principal.storage.trash;
  if (path === null || trash === undefined)
    throw new Error("Trash is not configured for this login; no file was deleted");
  return { path, trash };
}

export async function trashPath(deps: McpToolDeps, principal: Principal, rawPath: string) {
  const configured = requireTrash(deps, principal);
  const path = ordinaryPath(deps, principal, rawPath);
  assertMutablePath(principal, path, configured.path);
  const stat = await principal.storage.stat(path);
  if (stat.kind === "dir") await principal.storage.deleteDir(path);
  else await principal.storage.deleteFile(path);
  return {
    trashed: path,
    ...(await mutationEffects(deps, principal, {
      kind: "trash",
      path,
      isDir: stat.kind === "dir",
    })),
  };
}

export async function listTrash(
  deps: McpToolDeps,
  principal: Principal,
  args: { offset?: number | undefined; limit?: number | undefined },
) {
  const { trash } = requireTrash(deps, principal);
  const listing = await trash.list({ limit: 10_000 });
  const entries = listing.entries
    .filter((entry) => canReadPath(principal, entry.originalPath))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offset = args.offset ?? 0;
  const end = offset + (args.limit ?? 100);
  return {
    entries: entries
      .slice(offset, end)
      .map((entry) => ({ ...entry, deletedAt: entry.deletedAt.toISOString() })),
    partial: listing.truncated,
    ...(end < entries.length ? { next_offset: end } : {}),
  };
}

export async function restorePath(
  deps: McpToolDeps,
  principal: Principal,
  args: { id: string; target?: string | undefined },
) {
  const { trash, path: trashRoot } = requireTrash(deps, principal);
  // Ask the provider to decode its own layout; never guess a different original path from an id.
  const listing = await trash.list({ limit: 10_000 });
  const candidate = listing.entries.find((entry) => entry.id === args.id);
  if (candidate === undefined) throw new Error("item is not in the available Trash listing");
  const original = ordinaryPath(deps, principal, candidate.originalPath);
  const target = ordinaryPath(deps, principal, args.target ?? original);
  const publicUrl = await deps.publicUrl();
  const result = await trash.restore(args.id, { target });
  let moveMetadata = false;
  let warnings: string[] = [];
  if (original !== target) {
    try {
      await principal.storage.stat(original);
    } catch (error) {
      if (isStorageError(error) && error.kind === "not_found") moveMetadata = true;
      else warnings = ["Item restored, but original-path metadata could not be checked."];
    }
  }
  const effects = await mutationEffects(deps, principal, {
    kind: "restore",
    path: original,
    target: result.path,
    eventPath: trashLeafPath(trashRoot, args.id),
    moveMetadata,
    isDir: result.kind === "dir",
  });
  warnings = [...warnings, ...(effects.warnings ?? [])];
  return {
    restored: result.path,
    url:
      result.kind === "dir" ? folderUrl(publicUrl, result.path) : fileUrl(publicUrl, result.path),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function requireMetadata(deps: McpToolDeps) {
  if (deps.metadata === undefined) throw new Error("file metadata is unavailable");
  return deps.metadata;
}

export async function fileTags(
  deps: McpToolDeps,
  principal: Principal,
  rawPath: string,
  names?: string[],
) {
  requireExplicitAccess(principal);
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
        modifiedAt: info.modified ?? new Date(0).toISOString(),
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
  principal: Principal,
  args: { path: string; favorite: boolean },
) {
  requireExplicitAccess(principal);
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
  principal: Principal,
  args: { query: string; limit?: number | undefined },
) {
  requireExplicitAccess(principal);
  if (deps.imageSearchService === undefined)
    return { query: args.query, hits: [], unavailable: true };
  const identity = await deps.identities.get(principal.identityId);
  const verified =
    identity === null ? null : await deps.scopeResolver.verifiedIndexScopes(identity);
  const response = await deps.imageSearchService.search({
    query: args.query,
    limit: args.limit ?? 20,
    scopes: verified?.available ? tokenScopes(principal, verified.scopes) : [],
    authorizer: createReadAuthorizer({ storage: principal.storage }),
    trashPath: trashPathFor(deps, principal),
  });
  const publicUrl = await deps.publicUrl();
  return {
    ...response,
    hits: response.hits.map((hit) => ({ ...hit, url: fileUrl(publicUrl, hit.path) })),
  };
}
