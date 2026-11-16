import { createHash, randomUUID } from "node:crypto";
import type {
  DesktopBaseVersion,
  DesktopEntry,
  DesktopFolderCheck,
  DesktopFolderCheckResponse,
  DesktopFolderRequest,
  DesktopFolderState,
  DesktopMoveRequest,
  DesktopOperationResult,
  DesktopUploadRequest,
  DesktopWriteCapabilities,
  DesktopWriteEntry,
} from "@fdrive/contracts";
import {
  baseName,
  type ContentStamp,
  isStorageError,
  isUnderPath,
  normalizePath,
  parentPath,
  StorageError,
  type StorageProvider,
  TRASH_PATH,
  trashItemOf,
  trashItemPath,
} from "@fdrive/core";
import type {
  DesktopAccessMove,
  DesktopItemRecord,
  DesktopOperationRecord,
  DesktopRepo,
  NativeActivityFacts,
} from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { gated, ungated, type WriteGate } from "../backups/write-gate.js";
import { checkRestore, encryptedAccessAllowed, encryptedFoldersOf } from "../encryption/guard.js";
import { ApiHttpError } from "../errors.js";
import { runStorageCall } from "../fs/routes.js";
import type { MetadataService } from "../metadata/service.js";
import { followIntoTrash, type OwnerPath } from "../metadata/trash.js";
import type { TrashItems } from "../trash/items.js";
import {
  createDesktopFiles,
  DESKTOP_INTERNAL_ROOT,
  DESKTOP_PAGE_SIZE,
  digestFile,
  storedEntry,
} from "./files.js";
import type { DesktopDeps } from "./pairing.js";
import { incomingPath, removeIncoming } from "./retention.js";

/** The largest file the Mac app may write, told to it when it pairs. */
export const DESKTOP_MAX_UPLOAD_BYTES = 16 * 1024 ** 3;
export const NO_WRITES: DesktopWriteCapabilities = {
  create: false,
  update: false,
  move: false,
  trash: false,
  restore: false,
};
const ALL_WRITES: DesktopWriteCapabilities = {
  create: true,
  update: true,
  move: true,
  trash: true,
  restore: true,
};
/**
 * Its user's Trash as the Mac sees it, each item named by its handle:
 * `<this>/<handle>` for an item, then paths inside it. Shipped Mac apps
 * list, read and restore it here.
 */
export const DESKTOP_TRASH = `${DESKTOP_INTERNAL_ROOT}/trash`;
/** The most items the Mac's Trash lists. */
const TRASH_LIMIT = 100_000;
/** Whether `path` lies in its user's Trash: an item there, or something inside one. */
const inTrash = (path: string) => isUnderPath(TRASH_PATH, path);
/** The Trash item `path` is or lies in (`/.trash/<id>/<name>`), or null outside one. */
const leafOf = (path: string) => trashItemOf(path)?.path ?? null;
/**
 * A Trash item's name in the Mac's Trash, unique there by its handle, with
 * its extension kept for Finder and Quick Look. A restore under this name
 * takes back the original one, which is the item's name in Trash.
 */
function trashName(name: string, id: string) {
  const dot = name.lastIndexOf(".");
  // Bound by UTF-8 bytes and retain the extension for Finder/Quick Look.
  const extensionChars = [...(dot > 0 ? name.slice(dot) : "")];
  while (Buffer.byteLength(extensionChars.join("")) > 64) extensionChars.pop();
  const suffix = ` (deleted ${id.slice(0, 8)})${extensionChars.join("")}`;
  const stem = [...(dot > 0 ? name.slice(0, dot) : name)];
  while (Buffer.byteLength(stem.join("") + suffix) > 255) stem.pop();
  return stem.join("") + suffix;
}
type Request =
  | (DesktopUploadRequest & { kind: "upload" })
  | (DesktopFolderRequest & { kind: "folder" })
  | (DesktopMoveRequest & { kind: "move" });
/** The item a write changes, as its commit found it. */
type Source = Pick<DesktopItemRecord, "id" | "path" | "kind">;
/**
 * What a commit publishes, recorded on its operation right before the one
 * storage call that publishes it, so whoever finds the operation still
 * `committing` can tell from disk whether that call happened (`settle`).
 */
interface Publication {
  /** The staged upload or folder, or the item a move takes. */
  readonly from: string;
  /** Null for a move to Trash, whose leaf its Trash item names (`trash`). */
  readonly to: string | null;
  /** The inode at `from`, which publishing takes to `to`, in decimal. */
  readonly inode: string;
  /** Null for a new item. */
  readonly source: Source | null;
  /**
   * For a move to Trash: where the item lies in its owner's files, whose
   * Trash takes it. That is this login's own, or, in a folder shared with
   * it, the owner's.
   */
  readonly owner?: { readonly identityId: string; readonly path: string };
  /** For a move to Trash: the Trash item it becomes, written before it moves. */
  readonly trash?: { readonly id: string; readonly name: string };
}
export interface DesktopWriteDeps extends Pick<DesktopDeps, "clock" | "indexedContent"> {
  repo: DesktopRepo;
  /** Storage for an identity, whose deletes take what a write staged for good. */
  storageForIdentity: (identityId: string) => Promise<StorageProvider>;
  /**
   * What grants access to a path (public links, folders shared with people)
   * when a write moves it from `from` to `to`, applied with the receipt
   * (`DesktopRepo.complete`). Absent in fixtures that do not exercise sharing.
   */
  access?: (
    identityId: string,
    from: string,
    to: string,
    directory: boolean,
  ) => Promise<DesktopAccessMove | null>;
  /**
   * The rest of path-keyed metadata, through the service web writes use,
   * without what grants access (above) and without `withDesktopMetadata`: a
   * commit keeps the Mac's item handles itself. Absent in fixtures that do
   * not exercise metadata.
   */
  metadata?: Pick<MetadataService, "onMoved" | "onDeleted">;
  /**
   * Where a path lies in its owner's files (`LocalGrantService.ownerPath`), so
   * a move to Trash in a folder shared with the login is followed into its
   * owner's Trash. Absent in fixtures, where every path is the login's own.
   */
  ownerPath?: OwnerPath;
  /**
   * Deletes the item `id` in a user's Trash for good, the way Delete
   * permanently does (`FileOperations.purge`).
   */
  purge: (principal: Principal, id: string) => Promise<void>;
  /** What each login's Trash holds, by its rows; they change inside a commit's write. */
  trash: Pick<TrashItems, "get" | "list" | "begin" | "settle">;
  /**
   * The backups' write gate, which a commit holds from its start to its end
   * (`exclusive`), so a capture's snapshot sees all of it or none. A body
   * staged for a later commit holds nothing. Absent, nothing is held.
   */
  gate?: WriteGate;
  /** Hears metadata that could not follow a published write, and bookkeeping left behind. */
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Names a complete listing exactly as the client received it. */
const listingToken = (entries: readonly DesktopWriteEntry[]) => `v1:${hash(entries)}`;
function fail(code: string, message: string): never {
  throw new ApiHttpError("conflict", message, { code });
}
const collisionName = (value: string) => value.normalize("NFC").toLowerCase();
/** What the client is told whenever the destination no longer holds what it edited. */
const CHANGED = "This file changed remotely. Your pending copy is preserved.";
const COLLISION = "An item with this name already exists";
const UUID = /^[a-f0-9-]{36}$/;
/** Whether `now` is still the file `then` was read from; see `ContentStamp`. */
const sameFile = (now: ContentStamp, then: ContentStamp, inodeOnly: boolean) =>
  now.ino === then.ino &&
  (inodeOnly ||
    (now.size === then.size && now.mtimeNs === then.mtimeNs && now.ctimeNs === then.ctimeNs));
/** An operation's result without the publication its commit recorded. */
function settled(result: Record<string, unknown> | null) {
  const { publication: _, ...rest } = result ?? {};
  return rest;
}
/**
 * What is at `path` and its inode, spelled as asked: on a disk that ignores
 * case, the old name of a case-only rename is not its new one. Null when
 * nothing is there under that spelling.
 */
async function entryAt(storage: StorageProvider, path: string) {
  try {
    const found = await storage.stat(path);
    return found.path === path ? { kind: found.kind, ino: found.ino } : null;
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") return null;
    throw error;
  }
}
/**
 * Mac writes. An upload is staged in its owner's files and a commit
 * publishes it with one `rename` (or a `link`, for a new name), so whether
 * a commit published is always on disk: a commit records what it is about
 * to publish, and whoever finds it interrupted reads the outcome from disk
 * and finishes it (`settle`). Nothing is ever uncertain, and nothing is
 * published twice.
 */
export function createDesktopWrites(deps: DesktopWriteDeps) {
  const files = createDesktopFiles(deps, true);
  const uploads = new Map<string, AbortController>();
  /** The commit or settlement under way in this process, per operation. */
  const running = new Map<string, Promise<unknown>>();
  const repo = deps.repo;
  const gate = deps.gate ?? ungated;
  const ownerPath: OwnerPath =
    deps.ownerPath ?? (async (identityId: string, path: string) => ({ identityId, path }));
  /**
   * Where a recorded publication stands, from disk alone: `to` holds its
   * inode (published there), `from` still does (not published), or neither,
   * when something else has happened to it since (lost). A move to Trash is
   * published at its Trash item's path in its owner's files.
   */
  async function whereIs(
    principal: Principal,
    publication: Publication,
  ): Promise<{ at: "published"; to: string } | { at: "pending" | "lost" }> {
    const inode = BigInt(publication.inode);
    const holds = async (storage: StorageProvider, path: string) =>
      (await entryAt(storage, path))?.ino === inode;
    const { from, to, owner, trash } = publication;
    if (to !== null && (await holds(principal.storage, to))) return { at: "published", to };
    if (await holds(principal.storage, from)) return { at: "pending" };
    if (to === null && owner && trash) {
      const leaf = trashItemPath(trash.id, trash.name);
      if (await holds(await deps.storageForIdentity(owner.identityId), leaf))
        return { at: "published", to: leaf };
    }
    return { at: "lost" };
  }
  /** Writes need a grant of full access, and nothing else. */
  function capabilities(principal: Principal): DesktopWriteCapabilities {
    return principal.tokenAccess?.mode === "full" ? ALL_WRITES : NO_WRITES;
  }
  /**
   * Refuses publication unless `path` is still the file `witness` was read
   * from: the same inode, and for a save also the same size, modification
   * time and change time. Any write moves the change time on, and nobody can
   * set it, so this sees every write since `witness`, whoever made it. Only
   * the instant between this read and the rename stays open, as it does for
   * every other writer of the files folder.
   *
   * Only a missing file is a conflict. Any other storage failure propagates so
   * the caller maps it to a retryable status; reporting it as a remote change
   * would make the client fork a conflict copy of an untouched file.
   */
  async function unchanged(
    storage: StorageProvider,
    path: string,
    witness: ContentStamp,
    inodeOnly = false,
  ) {
    const now = await storage.contentStamp(path).catch((error: unknown) => {
      if (isStorageError(error) && error.kind === "not_found") return undefined;
      throw error;
    });
    if (!now || !sameFile(now, witness, inodeOnly)) fail("version_conflict", CHANGED);
  }
  /** `unchanged` for a folder, which has no stamp: it is still there. */
  async function stillFolder(storage: StorageProvider, path: string) {
    const found = await storage.stat(path).catch((error: unknown) => {
      if (isStorageError(error) && error.kind === "not_found") return undefined;
      throw error;
    });
    if (found?.kind !== "dir") fail("version_conflict", CHANGED);
  }
  /**
   * Refuses a write this connection may not make, from the grant the route
   * resolved for this request (`routes.ts`). A commit reads the token once
   * more, right before it publishes (`stillGranted`).
   */
  function authority(principal: Principal) {
    if (!capabilities(principal).create)
      throw new ApiHttpError("forbidden", "This location cannot enforce safe writes", {
        code: "unsupported",
      });
  }
  /**
   * A commit's one recheck of its authority, made right before it publishes,
   * so a token revoked, expired or changed while the commit hashed, staged or
   * copied publishes nothing. One read of the token (`routes.ts`).
   */
  const granted = async (principal: Principal) =>
    !principal.verifyAuthority || (await principal.verifyAuthority());
  function revoked(): never {
    throw new ApiHttpError("unauthorized", "Connection was revoked");
  }
  async function stillGranted(principal: Principal) {
    if (!(await granted(principal))) revoked();
  }
  async function record(principal: Principal, id: string) {
    if (id === "trash") throw new ApiHttpError("bad_request", "Trash itself cannot change");
    const result =
      id === "root"
        ? await repo.ensure(principal.identityId, "/", "dir")
        : await repo.item(principal.identityId, id);
    if (!result) throw new ApiHttpError("not_found", "Item no longer exists");
    await (inTrash(result.path)
      ? trashedEntry(principal, result.path)
      : files.stat(principal, result.path));
    return result;
  }
  async function decorate(
    principal: Principal,
    entry: DesktopEntry,
    content?: string,
  ): Promise<DesktopWriteEntry> {
    return (await decorateMany(principal, [entry], content))[0] as DesktopWriteEntry;
  }
  /**
   * Registers the entries and their parents in one registry call, and
   * presents them. Something in Trash is shown in the Mac's Trash, under the
   * handle of the Trash item it is or lies in; a Trash item's parent is
   * Trash itself.
   */
  async function decorateMany(
    principal: Principal,
    entries: readonly DesktopEntry[],
    content?: string,
  ): Promise<DesktopWriteEntry[]> {
    const parent = (path: string) => (path === "/" ? path : parentPath(path));
    const rows = new Map(
      (
        await repo.ensureMany(
          principal.identityId,
          entries.flatMap(({ path, kind }) => {
            const leaf = leafOf(path);
            if (leaf === path) return [{ path, kind }];
            return [
              { path, kind },
              { path: parent(path), kind: "dir" },
              ...(leaf ? [{ path: leaf, kind: "dir" }] : []),
            ];
          }),
        )
      ).map((row) => [row.path, row]),
    );
    const row = (path: string) => rows.get(path) as DesktopItemRecord;
    return entries.map((entry) => {
      const item = row(entry.path);
      const leaf = leafOf(entry.path);
      if (leaf === entry.path)
        return present(principal, entry, item, "trash", content, {
          path: `${DESKTOP_TRASH}/${item.id}`,
          name: trashName(baseName(leaf), item.id),
        });
      const above = row(parent(entry.path));
      return present(
        principal,
        entry,
        item,
        above.path === "/" ? "root" : above.id,
        content,
        leaf
          ? {
              path: `${DESKTOP_TRASH}/${row(leaf).id}${entry.path.slice(leaf.length)}`,
              name: entry.name,
            }
          : undefined,
      );
    });
  }
  /**
   * The registry's item as the Mac sees it. `shown` is its place in the
   * Mac's Trash, for something in Trash.
   */
  function present(
    principal: Principal,
    entry: DesktopEntry,
    item: Pick<DesktopItemRecord, "id" | "metadataVersion">,
    parentId: string,
    content?: string,
    shown?: { path: string; name: string },
  ): DesktopWriteEntry {
    const metadata = hash([
      item.metadataVersion,
      entry.path,
      entry.kind,
      entry.size,
      // A folder's modification time moves whenever something in it changes,
      // which says nothing about the folder a Finder rename moves.
      entry.kind === "dir" ? null : entry.modifiedAt,
    ]);
    const trashed = shown !== undefined;
    return {
      ...entry,
      ...shown,
      id: entry.path === "/" ? "root" : item.id,
      parentId,
      version: { content: content ?? `unverified:${metadata}`, metadata },
      capabilities: entry.readable
        ? trashed
          ? {
              ...NO_WRITES,
              restore: capabilities(principal).restore,
              move: capabilities(principal).restore,
            }
          : capabilities(principal)
        : NO_WRITES,
      trashed,
    };
  }
  /** Whether this connection's grants reach `path`. */
  const reaches = (principal: Principal, path: string) =>
    principal.tokenAccess?.paths.some((root) => root === path || isUnderPath(root, path)) === true;
  /** Where something in the login's own Trash was before it went there, or null outside one. */
  async function originalOf(principal: Principal, path: string) {
    const leaf = trashItemOf(path);
    const item = leaf && (await deps.trash.get(principal.identityId, leaf.id));
    return leaf && item ? item.originalPath + path.slice(leaf.path.length) : null;
  }
  /** The entry at `path` in its user's Trash, where this connection reaches where it was. */
  async function trashedEntry(principal: Principal, path: string): Promise<DesktopEntry> {
    const original = await originalOf(principal, path);
    if (original === null) throw new ApiHttpError("not_found", "Item no longer exists");
    if (!reaches(principal, original))
      throw new ApiHttpError("forbidden", "This connection cannot access the trashed item");
    return storedEntry(principal.storage, path);
  }
  /** The path in its user's Trash that a path in the Mac's Trash names. */
  async function inUserTrash(principal: Principal, path: string) {
    const [handle = "", ...rest] = path.slice(DESKTOP_TRASH.length + 1).split("/");
    const item = UUID.test(handle) ? await repo.item(principal.identityId, handle) : null;
    if (!item || leafOf(item.path) !== item.path)
      throw new ApiHttpError("not_found", "Item no longer exists");
    return [item.path, ...rest].join("/");
  }
  /** Every item in the user's own Trash this connection reaches, newest first. */
  async function trashListing(principal: Principal) {
    const listing = await deps.trash.list(principal.identityId, TRASH_LIMIT);
    if (listing.truncated) throw new ApiHttpError("rate_limited", "Trash listing capacity reached");
    const entries: (DesktopEntry & { originalPath?: string })[] = [];
    for (const item of listing.items) {
      if (!reaches(principal, item.originalPath)) continue;
      try {
        // Where it came from, so a Mac can decrypt the name of an item from an encrypted folder.
        const stored = await storedEntry(principal.storage, trashItemPath(item.id, item.name));
        entries.push({ ...stored, originalPath: item.originalPath });
      } catch (error) {
        // Restored or deleted since the listing, or unreadable.
        if (!(error instanceof ApiHttpError && ["not_found", "forbidden"].includes(error.kind)))
          throw error;
      }
    }
    return decorateMany(principal, entries);
  }
  async function checkFolder(
    principal: Principal,
    folder: DesktopFolderCheck,
  ): Promise<DesktopFolderState> {
    const path = normalizePath(folder.path);
    // Trash entries come from the registry as much as from storage; always relist them.
    if (path === DESKTOP_TRASH || isUnderPath(DESKTOP_TRASH, path)) return "changed";
    try {
      const listing = await files.folder(principal, path);
      if (!listing) return "missing";
      if (listing.entries.length > DESKTOP_PAGE_SIZE) return "changed";
      const rows = new Map(
        (
          await repo.lookup(principal.identityId, [
            listing.path,
            ...listing.entries.map((entry) => entry.path),
          ])
        ).map((row) => [row.path, row]),
      );
      const parent = rows.get(listing.path);
      if (parent?.kind !== "dir") return "changed";
      const parentId = parent.path === "/" ? "root" : parent.id;
      const entries: DesktopWriteEntry[] = [];
      for (const entry of listing.entries) {
        const item = rows.get(entry.path);
        if (item?.kind !== entry.kind) return "changed";
        entries.push(present(principal, entry, item, parentId));
      }
      return listingToken(entries) === folder.token ? "unchanged" : "changed";
    } catch (error) {
      if (error instanceof ApiHttpError && error.kind === "not_found") return "missing";
      if (error instanceof ApiHttpError && error.kind === "forbidden") return "forbidden";
      throw error;
    }
  }
  async function unoccupied(
    principal: Principal,
    parent: DesktopItemRecord,
    name: string,
    source?: string,
  ) {
    const parentEntry = await files.stat(principal, parent.path);
    if (parentEntry.kind !== "dir")
      throw new ApiHttpError("bad_request", "Destination is not a folder");
    // Authorization for a browsable ancestor is weaker than permission to write it.
    if (
      !principal.tokenAccess?.paths.some(
        (root) => root === parent.path || isUnderPath(root, parent.path),
      )
    )
      throw new ApiHttpError("forbidden", "Destination is outside this connection's grants");
    if (
      parent.path === "/" &&
      collisionName(name) === collisionName(DESKTOP_INTERNAL_ROOT.slice(1))
    )
      throw new ApiHttpError("forbidden", "Reserved folder name");
    // The disk may tell case apart, so only this listing sees a name that
    // differs from a taken one in case or Unicode normalization alone.
    const candidates = await principal.storage.list(parent.path);
    if (
      candidates.some(
        (item) => collisionName(item.name) === collisionName(name) && item.path !== source,
      )
    )
      fail("name_collision", COLLISION);
    return `${parent.path === "/" ? "" : parent.path}/${name}`;
  }
  /**
   * Proves the source is still what the client based its write on, and
   * returns what publication must still find there: the file's stamp, or null
   * for a folder. The metadata version is the whole proof for a move, whose
   * rename takes along whatever content is there, so a move reads no content.
   * A save also proves the content: from the index row when the stamp shows
   * the row is current, else from one full read.
   */
  async function checkBase(
    principal: Principal,
    item: DesktopItemRecord,
    base: DesktopBaseVersion,
    save: boolean,
  ): Promise<ContentStamp | null> {
    if (item.path === "/") throw new ApiHttpError("forbidden", "Cannot change the root folder");
    const live = inTrash(item.path)
      ? await trashedEntry(principal, item.path)
      : reaches(principal, item.path)
        ? await files.stat(principal, item.path)
        : null;
    if (!live) throw new ApiHttpError("forbidden", "Source is outside this connection's grants");
    const current = await decorate(principal, live);
    if (current.version.metadata !== base.metadata)
      fail("version_conflict", "This item changed remotely. Your pending copy is preserved.");
    if (live.kind !== "file") return null;
    if (!save) return runStorageCall(() => principal.storage.contentStamp(item.path));
    const { stamp, version } = await files.proven(principal, item.path);
    if (version !== base.content) fail("version_conflict", CHANGED);
    return stamp;
  }
  /** What the receipt's history records about a published write; `to` is a leaf for a trash. */
  async function activityFacts(
    principal: Principal,
    request: Request,
    source: Source | null,
    target: string,
    trashing: boolean,
  ): Promise<NativeActivityFacts> {
    const restored = source !== null && inTrash(source.path);
    return {
      from: source ? ((await originalOf(principal, source.path)) ?? source.path) : null,
      to: target,
      directory: request.kind === "folder" || source?.kind === "dir",
      trash: trashing,
      ...(restored ? { restored } : {}),
    };
  }
  /**
   * Brings the rest of path-keyed metadata along once a write is published
   * and its receipt (with what grants access) kept, the way web writes do
   * right after their storage call (`files/operations.ts`): tags, favorites, folder
   * views, recents, AI chat references and Office files follow a move, into
   * Trash and back out too (`followIntoTrash`), so nothing new at the old
   * path inherits them. The web hears of the write from the change journal,
   * as of every other.
   *
   * None of this grants access, so a failure is logged rather than failing
   * the commit, whose file is already published; what could not follow stays
   * where it was.
   */
  async function follow(
    principal: Principal,
    request: Request,
    source: Source | null,
    target: string,
    owner: { identityId: string; path: string } | null,
  ) {
    const { identityId } = principal;
    const directory = request.kind === "folder" || source?.kind === "dir";
    try {
      if (source && owner && deps.metadata)
        await followIntoTrash(deps.metadata, async () => owner, identityId, source.path, {
          leaf: target,
          kind: directory ? "dir" : "file",
        });
      else if (source && source.path !== target)
        await deps.metadata?.onMoved(identityId, source.path, target, directory);
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId, operationId: request.operationId },
        "Mac write published; its metadata could not follow",
      );
    }
  }
  async function operation(principal: Principal, id: string) {
    const result = await repo.operation(principal.identityId, principal.accountId, id);
    if (!result) throw new ApiHttpError("not_found", "Operation is not available");
    return result;
  }
  function status(op: DesktopOperationRecord): DesktopOperationResult {
    if (op.state === "completed" || op.state === "acknowledged")
      return op.result as unknown as DesktopOperationResult;
    // `recoveryId` is always null: the Mac app decodes the field, and fdrive
    // keeps no copy of what a write replaced.
    return {
      operationId: op.id,
      state: op.state as DesktopOperationResult["state"],
      item: null,
      recoveryId: null,
    };
  }
  function transition(
    principal: Principal,
    id: string,
    expected: string,
    state: string,
    result?: Record<string, unknown>,
    attempt?: string,
  ) {
    return repo.transition(
      principal.identityId,
      principal.accountId,
      id,
      expected,
      state,
      result,
      attempt,
    );
  }
  /**
   * Deletes what an operation staged once nothing can publish it any more.
   * Never fails the request: anything left goes when retention forgets the
   * operation.
   */
  async function discard(principal: Principal, id: string) {
    try {
      await removeIncoming(
        await deps.storageForIdentity(principal.identityId),
        principal.identityId,
        id,
      );
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId: principal.identityId, operationId: id },
        "Mac write staging stays until retention removes it",
      );
    }
  }
  /**
   * Runs `run`, a commit or settlement, once no other of the same operation
   * is under way in this process, so the outcome of one is never read from
   * disk halfway through by another. It holds the backups' write gate, and
   * only from there: a commit waiting for another holds nothing.
   */
  async function exclusive<T>(principal: Principal, id: string, run: () => Promise<T>) {
    const key = `${principal.identityId}:${id}`;
    for (let current = running.get(key); current; current = running.get(key))
      await current.catch(() => undefined);
    const task = gated(gate, run);
    running.set(key, task);
    try {
      return await task;
    } finally {
      if (running.get(key) === task) running.delete(key);
    }
  }
  /**
   * Keeps the receipt of a published write: the registry follows it, then
   * the receipt, its history and what grants access to the moved path
   * commit in one transaction (`DesktopRepo.complete`), so no link or share
   * stays at a path the write left, where a new item could appear. Until
   * that transaction commits, the operation stays `committing` and a retry
   * finishes it (`settle`); a failure here is never success.
   */
  async function finish(
    principal: Principal,
    op: DesktopOperationRecord,
    publication: Publication,
    to: string,
  ): Promise<DesktopOperationResult> {
    const request = op.request as Request;
    const { identityId, accountId } = principal;
    const { source } = publication;
    const owner = publication.owner ?? null;
    let receipt: DesktopOperationResult;
    try {
      let item: DesktopWriteEntry;
      if (source && owner && owner.identityId !== identityId) {
        // It left this login's files as a deleted item does, so its handle
        // retires. Finder's Trash shows it until it lists Trash again.
        const entry = await storedEntry(await deps.storageForIdentity(owner.identityId), to);
        await repo.remove(identityId, source.path);
        item = present(
          principal,
          entry,
          { id: source.id, metadataVersion: op.id },
          "trash",
          undefined,
          {
            path: `${DESKTOP_TRASH}/${source.id}`,
            name: trashName(baseName(source.path), source.id),
          },
        );
      } else {
        // The handle follows the item, into Trash and back out too.
        if (source) await repo.move(identityId, source.path, to);
        // In Trash only when this write moved it there, from a place it reaches.
        const entry = inTrash(to)
          ? await storedEntry(principal.storage, to)
          : await files.stat(principal, to);
        item = await decorate(
          principal,
          entry,
          request.kind === "upload" ? request.sha256 : undefined,
        );
      }
      receipt = { operationId: op.id, state: "completed", item, recoveryId: null };
      // What grants access follows the item in its owner's files: into Trash, and back out with a restore.
      const from = owner ?? (source ? { identityId, path: source.path } : null);
      const access =
        from && deps.access && from.path !== to
          ? await deps.access(from.identityId, from.path, to, source?.kind === "dir")
          : null;
      const facts = await activityFacts(principal, request, source, to, owner !== null);
      // The Trash item it moved there arrives, or the one it restored leaves.
      const leaving = source ? trashItemOf(source.path) : null;
      const trash = publication.trash
        ? { entered: publication.trash.id, leaf: to }
        : leaving && leaving.path === source?.path
          ? { left: leaving.id }
          : undefined;
      if (!(await repo.complete(identityId, accountId, op.id, receipt, facts, access, trash))) {
        // Another settlement kept it first.
        const current = await operation(principal, op.id);
        if (current.state !== "completed" && current.state !== "acknowledged")
          throw Error(`Operation is ${current.state}`);
        return status(current);
      }
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId, operationId: op.id },
        "Mac write published; its receipt waits for the app's retry",
      );
      throw new ApiHttpError(
        "internal",
        "This write was published but could not be recorded yet. Retry to finish it.",
      );
    }
    await discard(principal, op.id);
    await follow(principal, request, source, to, owner);
    return receipt;
  }
  /**
   * Ends a `committing` operation no commit in this process is running,
   * from what disk shows of the publication it recorded: published, it
   * keeps the receipt (`finish`); still unpublished, or never recorded, it
   * is `ready` to commit again; lost (something else has happened at both
   * ends since), it is a `conflict`, never a second publication.
   */
  async function settle(principal: Principal, op: DesktopOperationRecord) {
    const publication = op.result?.publication as Publication | undefined;
    const where = publication ? await whereIs(principal, publication) : null;
    if (publication && where?.at === "published")
      await finish(principal, op, publication, where.to);
    else {
      await transition(
        principal,
        op.id,
        "committing",
        where?.at === "lost" ? "conflict" : "ready",
        settled(op.result),
      );
      if (publication) await settleTrash(publication);
    }
    return operation(principal, op.id);
  }
  /**
   * Writes the Trash item a move of `path` to Trash becomes, in the Trash of
   * `owner`'s files, before it moves (`TrashItems.begin`).
   */
  async function beginTrash(
    principal: Principal,
    path: string,
    owner: { identityId: string; path: string },
  ) {
    const entry = await principal.storage.stat(path);
    const kind = entry.kind === "dir" ? "dir" : "file";
    return deps.trash.begin({
      identityId: owner.identityId,
      originalPath: owner.path,
      name: baseName(path),
      kind,
      size: kind === "file" ? entry.size : 0,
      deletedAt: deps.clock(),
      movingFrom: owner.path,
    });
  }
  /**
   * Settles the Trash item a move to Trash began by what is on disk, once
   * its receipt will not (`TrashItems.settle`): one that never moved is
   * forgotten. A failure leaves it for the next start.
   */
  async function settleTrash(publication: Publication) {
    const { owner, trash, source } = publication;
    if (!owner || !trash) return;
    try {
      await deps.trash.settle({
        id: trash.id,
        identityId: owner.identityId,
        name: trash.name,
        kind: source?.kind === "dir" ? "dir" : "file",
        movingFrom: owner.path,
      });
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId: owner.identityId, id: trash.id },
        "A Mac move to Trash that did not happen is settled at the next start",
      );
    }
  }
  /**
   * Takes the old name of a save that also renamed its file away to fdrive's
   * Trash, but only while it is still the file the save was based on. A file
   * someone wrote there since stays where it is.
   */
  async function retire(principal: Principal, path: string, witness: ContentStamp, id: string) {
    try {
      await unchanged(principal.storage, path, witness);
      const item = await beginTrash(principal, path, await ownerPath(principal.identityId, path));
      try {
        await principal.storage.trash.put(path, item.id);
      } finally {
        // It arrives with what was kept at its old name, or is forgotten.
        await deps.trash.settle(item);
      }
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId: principal.identityId, operationId: id },
        "Mac save published under its new name; the old name stays",
      );
    }
  }
  /** Deletes one superseded upload attempt's body. Retention takes it if this fails. */
  async function discardAttempt(principal: Principal, path: string) {
    try {
      await (await deps.storageForIdentity(principal.identityId)).deleteFile(path);
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId: principal.identityId, path },
        "A superseded Mac upload stays until retention removes it",
      );
    }
  }
  /**
   * One commit attempt of an operation it moved to `committing`. Checks the
   * request against storage, records what it will publish, checks once more
   * and makes the one storage call that publishes: a rename over the
   * original for a save in place, a link for a new name (a real
   * create-if-absent, so of two creates racing for a name one gets
   * `name_collision`), a rename for a move or a new folder, `trash.put` for
   * a move to Trash and `trash.restore` for one back out. Then it keeps the
   * receipt (`finish`).
   *
   * A failure before that call leaves the operation `ready` (or a
   * `conflict`). Once the call is made, disk tells what happened: published,
   * the receipt follows; not, it is `ready` again; neither, a `conflict`.
   */
  async function publish(
    principal: Principal,
    op: DesktopOperationRecord,
  ): Promise<DesktopOperationResult> {
    const id = op.id;
    const request = op.request as Request;
    const storage = principal.storage;
    const trashing = request.parentId === "trash";
    let publication: Publication;
    let witness: ContentStamp | null;
    /** The Trash item a move to Trash becomes, once it is written. */
    let arriving: Publication | undefined;
    try {
      const source =
        "itemId" in request && request.itemId ? await record(principal, request.itemId) : undefined;
      if (trashing && (request.kind !== "move" || !source || inTrash(source.path)))
        throw new ApiHttpError("bad_request", "Only existing items can be moved to Trash");
      if (request.kind === "upload" && source && inTrash(source.path))
        throw new ApiHttpError("forbidden", "Restore this item before editing it");
      if (request.kind === "upload" && source && source.kind !== "file")
        throw new ApiHttpError("bad_request", "Only regular files can be replaced");
      // A Trash item restored under its name in the Mac's Trash takes back its own.
      const name =
        source &&
        leafOf(source.path) === source.path &&
        request.name === trashName(baseName(source.path), source.id)
          ? baseName(source.path)
          : request.name;
      const target = trashing
        ? null
        : await unoccupied(
            principal,
            await record(principal, request.parentId),
            name,
            source?.path,
          );
      // What the source must still be when it is published over or moved.
      witness =
        source && "base" in request && request.base
          ? await checkBase(principal, source, request.base, request.kind === "upload")
          : null;
      if (source && target && isUnderPath(source.path, target))
        throw new ApiHttpError("bad_request", "Cannot move a folder into itself");
      const incoming = incomingPath(principal.identityId, id);
      let from: string;
      if (request.kind === "move") from = (source as DesktopItemRecord).path;
      else if (request.kind === "folder") {
        from = `${incoming}/${randomUUID()}`;
        await runStorageCall(() => storage.mkdir(from, { parents: true }));
      } else {
        const uploadFile = op.result?.uploadFile;
        if (typeof uploadFile !== "string" || !UUID.test(uploadFile))
          throw Error("Missing upload receipt");
        from = `${incoming}/${uploadFile}`;
      }
      const staged = await runStorageCall(() => entryAt(storage, from));
      if (staged === null) {
        if (request.kind === "move") fail("version_conflict", CHANGED);
        // The staged body is gone: the app sends it again.
        await transition(principal, id, "committing", "receiving", {});
        return status(await operation(principal, id));
      }
      if (request.kind === "upload" && staged.kind !== "file")
        throw new ApiHttpError("forbidden", "Unsupported staging entry");
      publication = {
        from,
        to: target,
        inode: staged.ino.toString(),
        source: source ? { id: source.id, path: source.path, kind: source.kind } : null,
      };
      if (trashing && source) {
        const owner = await ownerPath(principal.identityId, source.path);
        const item = await beginTrash(principal, source.path, owner);
        publication = { ...publication, owner, trash: { id: item.id, name: item.name } };
        arriving = publication;
      }
      if (
        !(await transition(principal, id, "committing", "committing", {
          ...op.result,
          publication,
        }))
      )
        throw Error("Operation changed while committing");
      if (from !== target) {
        // Right before publishing: the token, and the source as the base proved it.
        await stillGranted(principal);
        if (source && witness)
          await unchanged(storage, source.path, witness, request.kind === "move");
        else if (source) await stillFolder(storage, source.path);
      }
    } catch (error) {
      const conflict = error instanceof ApiHttpError && error.kind === "conflict";
      await transition(
        principal,
        id,
        "committing",
        conflict ? "conflict" : "ready",
        settled(op.result),
      );
      if (arriving) await settleTrash(arriving);
      if (error instanceof StorageError) throw new ApiHttpError(error.kind, error.message);
      throw error;
    }
    const { from, source, trash } = publication;
    let to = publication.to;
    const leaving = trashItemOf(from);
    try {
      // A move to Trash always names the Trash item it becomes.
      if (to === null) to = (await storage.trash.put(from, (trash as { id: string }).id)).leaf;
      else if (leaving?.path === from) {
        const original = await originalOf(principal, from);
        if (original !== null) await checkRestore(storage, original, to);
        await storage.trash.restore(leaving.id, baseName(from), to);
      }
      // A move onto itself publishes nothing.
      else if (from !== to)
        await storage.move(
          from,
          to,
          request.kind === "move"
            ? { overwrite: false }
            : { overwrite: source?.path === to, publish: true },
        );
    } catch (error) {
      // Storage refuses a taken name before writing anything.
      if (isStorageError(error) && error.kind === "conflict") {
        await transition(principal, id, "committing", "conflict", settled(op.result));
        await settleTrash(publication);
        fail("name_collision", COLLISION);
      }
      const where = await whereIs(principal, publication).catch(() => null);
      // Still `committing`: the app's retry reads the outcome (`settle`).
      if (where === null)
        throw new ApiHttpError("internal", "This write could not be confirmed yet. Retry it.");
      if (where.at !== "published") {
        await transition(
          principal,
          id,
          "committing",
          where.at === "lost" ? "conflict" : "ready",
          settled(op.result),
        );
        await settleTrash(publication);
        if (where.at === "lost") fail("version_conflict", CHANGED);
        if (error instanceof StorageError) throw new ApiHttpError(error.kind, error.message);
        throw error;
      }
      to = where.to;
    }
    if (request.kind === "upload" && source && witness && source.path !== to)
      await retire(principal, source.path, witness, id);
    return finish(principal, op, publication, to);
  }
  async function prepare(principal: Principal, request: Request) {
    authority(principal);
    const prior = await repo.operation(
      principal.identityId,
      principal.accountId,
      request.operationId,
    );
    if (prior) {
      if (prior.requestHash !== hash(request))
        throw new ApiHttpError("conflict", "Operation ID was reused with different contents");
      if (prior.state !== "committing") return status(prior);
      // Every retry of a Mac write starts here, so here an interrupted
      // commit ends; the app commits again when this answers `ready`.
      return status(
        await exclusive(principal, prior.id, async () => {
          const current = await operation(principal, prior.id);
          return current.state === "committing" ? settle(principal, current) : current;
        }),
      );
    }
    if (request.kind === "upload") {
      if (request.size > DESKTOP_MAX_UPLOAD_BYTES)
        throw new ApiHttpError("bad_request", "File exceeds the 16 GiB upload limit", {
          code: "quota_exceeded",
        });
      if (!!request.itemId !== !!request.base)
        throw new ApiHttpError("bad_request", "Updates require an item and base version");
    }
    const trashing = request.parentId === "trash";
    if (trashing && request.kind !== "move")
      throw new ApiHttpError("bad_request", "Only existing items can be moved to Trash");
    const parent = trashing ? null : await record(principal, request.parentId);
    const source =
      "itemId" in request && request.itemId ? await record(principal, request.itemId) : undefined;
    if (request.kind === "upload" && source && inTrash(source.path))
      throw new ApiHttpError("forbidden", "Restore this item before editing it");
    const target = parent
      ? `${parent.path === "/" ? "" : parent.path}/${request.name}`
      : TRASH_PATH;
    const op = await repo.reserve({
      id: request.operationId,
      identityId: principal.identityId,
      accountId: principal.accountId,
      requestHash: hash(request),
      // History reads its facts from the reserved request, so an interrupted
      // commit still knows what the person asked for. `appendNativeActivity`
      // re-derives the final action from the facts its receipt records.
      request: {
        ...request,
        activityPath: source?.path ?? target,
        activityTarget: target,
        activityKind: source?.kind === "dir" || request.kind === "folder" ? "dir" : "file",
        activityAction:
          request.kind === "folder"
            ? "folder.create"
            : request.kind === "upload"
              ? source
                ? "file.save"
                : "file.create"
              : trashing
                ? "file.trash"
                : source && inTrash(source.path)
                  ? "file.restore"
                  : source && parentPath(source.path) === parent?.path
                    ? "file.rename"
                    : "file.move",
      },
      state: request.kind === "upload" ? "receiving" : "ready",
    });
    if (op.requestHash !== hash(request))
      throw new ApiHttpError("conflict", "Operation ID was reused with different contents");
    return status(op);
  }
  return {
    capabilities,
    decorate,
    files: {
      async content(principal: Principal, path: string) {
        if (!isUnderPath(DESKTOP_TRASH, path)) return files.content(principal, path);
        const physical = await inUserTrash(principal, path);
        const entry = await trashedEntry(principal, physical);
        if (entry.kind !== "file")
          throw new ApiHttpError("bad_request", "Only files can be downloaded");
        return runStorageCall(() => principal.storage.open(physical));
      },
      async versions(principal: Principal, paths: string[], signal: AbortSignal) {
        // Every file outside Trash in one call, so their index rows come in one lookup.
        const live = paths.filter((path) => !isUnderPath(DESKTOP_TRASH, path));
        const answered =
          live.length === 0 ? [] : (await files.versions(principal, live, signal)).items;
        if (live.length === paths.length) return { items: answered };
        const outside = answered.values();
        const items = [];
        for (const path of paths) {
          // `files.versions` answered every path outside Trash, in order.
          if (!isUnderPath(DESKTOP_TRASH, path)) {
            items.push(outside.next().value as (typeof answered)[number]);
            continue;
          }
          const physical = await inUserTrash(principal, path);
          const entry = await trashedEntry(principal, physical);
          if (entry.kind !== "file")
            throw new ApiHttpError("bad_request", "Only files have content versions");
          const value = await runStorageCall(() => digestFile(principal.storage, physical, signal));
          items.push({ path, size: value.size, version: value.sha256 });
        }
        return { items };
      },
    },
    async list(principal: Principal, path: string, tokenKey: string, cursor?: string) {
      if (path === DESKTOP_TRASH || isUnderPath(DESKTOP_TRASH, path)) {
        if (cursor) throw new ApiHttpError("conflict", "Refresh Trash to restart the listing");
        if (path === DESKTOP_TRASH)
          return { entries: await trashListing(principal), nextCursor: null };
        const physical = await inUserTrash(principal, path);
        await trashedEntry(principal, physical);
        const items = await runStorageCall(() => principal.storage.list(physical));
        if (items.length > TRASH_LIMIT)
          throw new ApiHttpError("rate_limited", "Trash listing capacity reached");
        const entries = items.map((item) => ({
          path: normalizePath(item.path),
          name: item.name,
          kind: item.kind,
          size: item.size,
          modifiedAt: item.modifiedAt.toISOString(),
          readable: item.kind === "file" || item.kind === "dir",
        }));
        return { entries: await decorateMany(principal, entries), nextCursor: null };
      }
      const result = await files.list(principal, path, tokenKey, cursor);
      const entries = await decorateMany(principal, result.entries);
      // Only an app that encrypts reaches inside an encrypted folder, so only it hears of them.
      const folders = encryptedAccessAllowed() ? encryptedFoldersOf(principal.storage) : null;
      const encryptedFolder = folders === null ? null : await folders.info(path);
      const marked =
        folders === null
          ? entries
          : await Promise.all(
              entries.map(async (entry) =>
                entry.kind === "dir" && (await folders.isFolder(entry.path))
                  ? { ...entry, encrypted: true as const }
                  : entry,
              ),
            );
      return {
        entries: marked,
        nextCursor: result.nextCursor,
        ...(!cursor && result.nextCursor === null ? { token: listingToken(entries) } : {}),
        ...(encryptedFolder === null ? {} : { encryptedFolder }),
      };
    },
    /**
     * Which folders still match the listing their token names, so the client lists only
     * the rest. Read-only: entries the registry has not seen make a folder changed, and
     * the listing that follows registers them.
     */
    async check(
      principal: Principal,
      folders: readonly DesktopFolderCheck[],
      signal: AbortSignal,
    ): Promise<DesktopFolderCheckResponse> {
      const results: DesktopFolderCheckResponse["folders"] = [];
      for (const folder of folders) {
        signal.throwIfAborted();
        results.push({ path: folder.path, status: await checkFolder(principal, folder) });
      }
      return { folders: results };
    },
    async stat(principal: Principal, path: string): Promise<DesktopWriteEntry> {
      if (path === DESKTOP_TRASH)
        return {
          id: "trash",
          parentId: "root",
          path,
          name: "Trash",
          kind: "dir",
          size: 0,
          modifiedAt: new Date(0).toISOString(),
          readable: true,
          version: { content: "trash", metadata: "trash" },
          capabilities: NO_WRITES,
          trashed: true,
        };
      return decorate(
        principal,
        isUnderPath(DESKTOP_TRASH, path)
          ? await trashedEntry(principal, await inUserTrash(principal, path))
          : await files.stat(principal, path),
      );
    },
    prepare,
    /**
     * Deletes an item in the user's own Trash for good, as Empty Trash does
     * (`FileOperations.purge`): Finder's Empty Trash, or a delete in its Trash. An
     * item gone already is done; anything else, a live item or something
     * inside a Trash item, is refused.
     */
    async purge(principal: Principal, itemId: string) {
      authority(principal);
      const item = await repo.item(principal.identityId, itemId);
      if (!item) return;
      const leaf = trashItemOf(item.path);
      if (leaf?.path !== item.path)
        throw new ApiHttpError("conflict", "Only items in Trash can be deleted permanently");
      const original = await originalOf(principal, item.path);
      // Its row went with it: deleted for good already.
      if (original === null) return;
      if (!reaches(principal, original))
        throw new ApiHttpError("forbidden", "This connection cannot access the trashed item");
      await deps.purge(principal, leaf.id);
    },
    async status(principal: Principal, id: string) {
      return status(await operation(principal, id));
    },
    /**
     * Streams the body straight into its staging file in the owner's files,
     * hashing and counting it as it arrives; storage flushes it to disk
     * before the name appears. A body that does not match what was prepared
     * leaves nothing behind.
     */
    async upload(
      principal: Principal,
      id: string,
      body: ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ) {
      authority(principal);
      const op = await operation(principal, id);
      const request = op.request as Request;
      if (request.kind !== "upload")
        throw new ApiHttpError("bad_request", "Operation does not accept content");
      if (!["receiving", "uploading"].includes(op.state)) return status(op);
      const attempt = randomUUID();
      const previousAttempt =
        typeof op.result?.attempt === "string" ? op.result.attempt : undefined;
      if (
        !(await transition(
          principal,
          id,
          op.state,
          "uploading",
          { attempt },
          op.state === "uploading" ? previousAttempt : undefined,
        ))
      )
        return status(await operation(principal, id));
      const uploadKey = `${principal.identityId}:${id}`;
      uploads.get(uploadKey)?.abort();
      const controller = new AbortController();
      uploads.set(uploadKey, controller);
      const path = `${incomingPath(principal.identityId, id)}/${attempt}`;
      const stop = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30 * 60_000)]);
      const sha = createHash("sha256");
      let size = 0;
      let invalid = false;
      const refuse = (message: string) => {
        invalid = true;
        return new ApiHttpError("bad_request", message, { code: "invalid_upload" });
      };
      // Ends the body when the request goes or another attempt starts, even
      // one whose source never sends another byte.
      let end: (reason: unknown) => void = () => undefined;
      const stopped = () => end(stop.reason);
      const verified = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          start(stream) {
            end = (reason) => stream.error(reason);
          },
          transform(chunk, stream) {
            stop.throwIfAborted();
            size += chunk.byteLength;
            if (size > request.size) throw refuse("Upload exceeds its declared length");
            sha.update(chunk);
            stream.enqueue(chunk);
          },
          flush() {
            stop.throwIfAborted();
            if (size !== request.size || sha.digest("hex") !== request.sha256)
              throw refuse("Upload length or digest does not match");
          },
        }),
      );
      stop.addEventListener("abort", stopped, { once: true });
      if (stop.aborted) stopped();
      let staged = false;
      try {
        try {
          await principal.storage.upload(path, verified, {
            mkdirParents: true,
            durable: true,
            signal: stop,
          });
        } catch (error) {
          // Storage reports a failure of the body as its own.
          if (invalid)
            throw new ApiHttpError("bad_request", "Upload length or digest does not match", {
              code: "invalid_upload",
            });
          throw error;
        }
        staged = true;
        if (
          !(await transition(principal, id, "uploading", "ready", { uploadFile: attempt }, attempt))
        )
          throw new ApiHttpError("conflict", "Upload attempt was superseded");
      } catch (error) {
        // A database response can be lost after the ready transition committed.
        const current = await operation(principal, id).catch(() => null);
        if (staged && current?.state === "ready" && current.result?.uploadFile === attempt)
          return status(current);
        await transition(principal, id, "uploading", "receiving", {}, attempt).catch(() => false);
        // Read, the operation names another body (or none), so this one goes;
        // unread, it might name this one, which retention removes if not.
        if (staged && current) await discardAttempt(principal, path);
        if (error instanceof StorageError) throw new ApiHttpError(error.kind, error.message);
        throw error;
      } finally {
        stop.removeEventListener("abort", stopped);
        if (uploads.get(uploadKey) === controller) uploads.delete(uploadKey);
      }
      return status(await operation(principal, id));
    },
    async commit(principal: Principal, id: string) {
      authority(principal);
      return exclusive(principal, id, async () => {
        let op = await operation(principal, id);
        if (op.state === "committing") op = await settle(principal, op);
        if (op.state !== "ready") return status(op);
        if (!(await transition(principal, id, "ready", "committing")))
          return status(await operation(principal, id));
        return publish(principal, op);
      });
    },
    /** Old apps acknowledge a receipt they kept; it only marks the operation done. */
    async acknowledge(principal: Principal, id: string) {
      const op = await operation(principal, id);
      if (!["completed", "acknowledged"].includes(op.state))
        throw new ApiHttpError("conflict", "Only a completed operation can be acknowledged");
      await transition(principal, id, "completed", "acknowledged");
      return status(op);
    },
    async cancel(principal: Principal, id: string) {
      const op = await operation(principal, id);
      if (op.state === "cancelled") return status(op);
      if (!["receiving", "ready", "conflict"].includes(op.state))
        throw new ApiHttpError("conflict", "A commit under way cannot be discarded");
      if (await transition(principal, id, op.state, "cancelled")) await discard(principal, id);
      return status(await operation(principal, id));
    },
  };
}
export type DesktopWrites = ReturnType<typeof createDesktopWrites>;
