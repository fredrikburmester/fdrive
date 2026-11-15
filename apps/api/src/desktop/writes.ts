import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
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
  type ContentStamp,
  isStorageError,
  isUnderPath,
  normalizePath,
  parentPath,
  StorageError,
  type StorageProvider,
} from "@fdrive/core";
import type {
  DesktopAccessMove,
  DesktopItemRecord,
  DesktopOperationRecord,
  DesktopRepo,
  NativeActivityFacts,
} from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import type { EventBus } from "../events/bus.js";
import { publishFsEvent, runStorageCall } from "../fs/routes.js";
import type { MetadataService } from "../metadata/service.js";
import {
  createDesktopFiles,
  DESKTOP_INTERNAL_ROOT,
  DESKTOP_PAGE_SIZE,
  digestFile,
  stampOf,
  storedEntry,
} from "./files.js";
import type { DesktopDeps } from "./pairing.js";

/** The largest file the Mac app may write, told to it when it pairs. */
export const DESKTOP_MAX_UPLOAD_BYTES = 16 * 1024 ** 3;
export const NO_WRITES: DesktopWriteCapabilities = {
  create: false,
  update: false,
  move: false,
  trash: false,
  restore: false,
};
export const DESKTOP_TRASH = `${DESKTOP_INTERNAL_ROOT}/trash`;
/** A precondition of Finder writes that this deployment does not meet. */
export type DesktopWriteGate = "state_dir";
export interface DesktopWriteAvailability {
  readonly capabilities: DesktopWriteCapabilities;
  /** Every unmet precondition, each its own thing to fix; empty when writable. */
  readonly missing: readonly DesktopWriteGate[];
}
type Request =
  | (DesktopUploadRequest & { kind: "upload" })
  | (DesktopFolderRequest & { kind: "folder" })
  | (DesktopMoveRequest & { kind: "move" });
export interface DesktopWriteDeps
  extends Pick<DesktopDeps, "clock" | "trashPathForStorage" | "indexedContent"> {
  repo: DesktopRepo;
  stateDir?: string;
  /**
   * What grants access to a path (public links, folders shared with people)
   * when a write moves it from `from` to `to`, resolved before publication
   * and applied with the receipt (`DesktopRepo.complete`). Absent in
   * fixtures that do not exercise sharing.
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
   * commit keeps the Mac's item handles itself, and that wrapper's
   * `onTrashed` would retire the handle of an item the Mac puts in its
   * Trash. Absent in fixtures that do not exercise metadata.
   */
  metadata?: Pick<MetadataService, "onMoved" | "onTrashed">;
  /** Live updates for the web, as web writes publish them. Absent in fixtures. */
  bus?: EventBus;
  /** Hears metadata that could not follow a published write, and bookkeeping left behind. */
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Administrator resolution of uncertain commits needs the identity's storage. */
  storageForIdentity?: (identityId: string) => Promise<StorageProvider>;
}
/** A commit that has not progressed for this long is treated as abandoned by its process. */
export const DESKTOP_COMMIT_STALL_MS = 15 * 60_000;
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

/** A database receipt is written before success. Committing without a receipt is
 * deliberately uncertain after restart: never infer ownership from matching bytes.
 * Both the native snapshot and server spool survive that outcome for recovery. */
export function createDesktopWrites(deps: DesktopWriteDeps) {
  const files = createDesktopFiles(deps, true);
  const uploads = new Map<string, AbortController>();
  const repo = deps.repo;
  const trashRoot = (p: Principal) => `${DESKTOP_INTERNAL_ROOT}/${p.identityId}/trash`;
  const inTrash = (p: Principal, path: string) => isUnderPath(trashRoot(p), path);
  function trashName(item: DesktopItemRecord) {
    const name = item.originalPath?.split("/").at(-1) ?? item.path.split("/").at(-1) ?? item.id;
    const dot = name.lastIndexOf(".");
    // Bound by UTF-8 bytes and retain the extension for Finder/Quick Look.
    const extensionChars = [...(dot > 0 ? name.slice(dot) : "")];
    while (Buffer.byteLength(extensionChars.join("")) > 64) extensionChars.pop();
    const suffix = ` (deleted ${item.id.slice(0, 8)})${extensionChars.join("")}`;
    const stem = [...(dot > 0 ? name.slice(0, dot) : name)];
    while (Buffer.byteLength(stem.join("") + suffix) > 255) stem.pop();
    return stem.join("") + suffix;
  }
  /** The grant's capabilities together with why a full grant still lands read-only. */
  function availability(principal: Principal): DesktopWriteAvailability {
    const missing: DesktopWriteGate[] = deps.stateDir ? [] : ["state_dir"];
    const writable = principal.tokenAccess?.mode === "full" && missing.length === 0;
    return {
      capabilities: writable
        ? { create: true, update: true, move: true, trash: true, restore: true }
        : NO_WRITES,
      missing,
    };
  }
  function capabilities(principal: Principal): DesktopWriteCapabilities {
    return availability(principal).capabilities;
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
    const now = await stampOf(storage, path).catch((error: unknown) => {
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
   * Refuses a write this connection may not make. The route resolved its
   * token for this request (`routes.ts`), which is the one check of its
   * authority a request makes.
   */
  function authority(principal: Principal) {
    if (!capabilities(principal).create)
      throw new ApiHttpError("forbidden", "This location cannot enforce safe writes", {
        code: "unsupported",
      });
  }
  async function record(principal: Principal, id: string) {
    if (id === "trash") return repo.ensure(principal.identityId, trashRoot(principal), "dir");
    const result =
      id === "root"
        ? await repo.ensure(principal.identityId, "/", "dir")
        : await repo.item(principal.identityId, id);
    if (!result) throw new ApiHttpError("not_found", "Item no longer exists");
    await (inTrash(principal, result.path)
      ? trashEntry(principal, result.path)
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
  /** Registers the entries and their parents in one registry call, parents first. */
  async function decorateMany(
    principal: Principal,
    entries: readonly DesktopEntry[],
    content?: string,
  ): Promise<DesktopWriteEntry[]> {
    const rows = await repo.ensureMany(principal.identityId, [
      ...entries.map(({ path, kind }) => ({ path, kind })),
      ...entries.map(({ path }) => ({ path: path === "/" ? path : parentPath(path), kind: "dir" })),
    ]);
    return entries.map((entry, index) =>
      present(
        principal,
        entry,
        rows[index] as DesktopItemRecord,
        rows[entries.length + index] as DesktopItemRecord,
        content,
      ),
    );
  }
  function present(
    principal: Principal,
    entry: DesktopEntry,
    item: DesktopItemRecord,
    parent: DesktopItemRecord,
    content?: string,
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
    const trashed = inTrash(principal, entry.path);
    return {
      ...entry,
      ...(trashed
        ? {
            path: DESKTOP_TRASH + entry.path.slice(trashRoot(principal).length),
            name: item.originalPath ? trashName(item) : entry.name,
          }
        : {}),
      id: entry.path === "/" ? "root" : item.id,
      parentId:
        parent.path === "/" ? "root" : parent.path === trashRoot(principal) ? "trash" : parent.id,
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
  async function trashEntry(principal: Principal, path: string): Promise<DesktopEntry> {
    const root = trashRoot(principal);
    if (!isUnderPath(root, path)) throw new ApiHttpError("forbidden", "Invalid recovery path");
    const top = `${root}/${path.slice(root.length + 1).split("/")[0]}`;
    const item = await repo.at(principal.identityId, top);
    const originalPath = item?.originalPath;
    if (
      !originalPath ||
      !principal.tokenAccess?.paths.some(
        (grant) => grant === originalPath || isUnderPath(grant, originalPath),
      )
    )
      throw new ApiHttpError("forbidden", "This connection cannot access the trashed item");
    return storedEntry(principal.storage, path);
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
      const entries: DesktopWriteEntry[] = [];
      for (const entry of listing.entries) {
        const item = rows.get(entry.path);
        if (item?.kind !== entry.kind) return "changed";
        entries.push(present(principal, entry, item, parent));
      }
      return listingToken(entries) === folder.token ? "unchanged" : "changed";
    } catch (error) {
      if (error instanceof ApiHttpError && error.kind === "not_found") return "missing";
      if (error instanceof ApiHttpError && error.kind === "forbidden") return "forbidden";
      throw error;
    }
  }
  function physicalTrashPath(principal: Principal, path: string) {
    if (!isUnderPath(DESKTOP_TRASH, path)) return null;
    return trashRoot(principal) + path.slice(DESKTOP_TRASH.length);
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
    if (
      !inTrash(principal, item.path) &&
      !principal.tokenAccess?.paths.some(
        (root) => root === item.path || isUnderPath(root, item.path),
      )
    )
      throw new ApiHttpError("forbidden", "Source is outside this connection's grants");
    const live = inTrash(principal, item.path)
      ? await trashEntry(principal, item.path)
      : await files.stat(principal, item.path);
    const current = await decorate(principal, live);
    if (current.version.metadata !== base.metadata)
      fail("version_conflict", "This item changed remotely. Your pending copy is preserved.");
    if (live.kind !== "file") return null;
    if (!save) return runStorageCall(() => stampOf(principal.storage, item.path));
    const { stamp, version } = await files.proven(principal, item.path);
    if (version !== base.content) fail("version_conflict", CHANGED);
    return stamp;
  }
  /** What the receipt's history records about a published write. */
  function activityFacts(
    principal: Principal,
    request: Request,
    source: DesktopItemRecord | null | undefined,
    target: string,
    trashing: boolean,
  ): NativeActivityFacts {
    return {
      from: source?.originalPath ?? source?.path ?? null,
      to: trashing ? DESKTOP_TRASH + target.slice(trashRoot(principal).length) : target,
      directory: request.kind === "folder" || source?.kind === "dir",
      trash: trashing,
      ...(source?.originalPath && !trashing ? { restored: true } : {}),
    };
  }
  async function missing(storage: StorageProvider, path: string) {
    try {
      await storage.stat(path);
      return false;
    } catch (error) {
      if (isStorageError(error) && error.kind === "not_found") return true;
      throw error;
    }
  }
  /**
   * What grants access to the moved path, resolved before publication so a
   * failed lookup leaves the operation ready, and applied with the receipt so
   * no link or share outlives the write at the path it left. For a restore it
   * is what followed the item into the Mac's Trash.
   */
  async function accessMove(
    principal: Principal,
    source: DesktopItemRecord | null | undefined,
    from: string | undefined,
    target: string,
  ) {
    if (!deps.access || !source || from === undefined || from === target) return null;
    return deps.access(principal.identityId, from, target, source.kind === "dir");
  }
  /**
   * Brings the rest of path-keyed metadata along once a write is published
   * and its receipt (with what grants access) kept, and tells the web, the
   * way web writes do right after their storage call (`fs/routes.ts`): tags,
   * favorites, folder views, recents, AI chat references and Office files
   * follow a move. A move into the Mac's Trash is a trash: recents go, and
   * the rest stays at the original path for a restore, which brings it back
   * as a web restore does (`trash/routes.ts`), only while nothing has taken
   * that path.
   *
   * None of this grants access, so a failure is logged rather than failing
   * the commit, whose file is already published. The indexer reports the
   * same move from the change journal, and its listener
   * (`events/indexer-listener.ts`) moves this metadata then; that also covers
   * a crash between the receipt and this call.
   */
  async function follow(
    principal: Principal,
    request: Request,
    source: DesktopItemRecord | null | undefined,
    target: string,
    trashing: boolean,
  ) {
    const { identityId } = principal;
    const directory = request.kind === "folder" || source?.kind === "dir";
    const metadata = deps.metadata;
    const publish = (
      op: "create" | "mkdir" | "move" | "delete",
      paths: string[],
      to?: string[],
    ) => {
      if (deps.bus) publishFsEvent({ bus: deps.bus, clock: deps.clock }, principal, op, paths, to);
    };
    try {
      if (source && trashing) await metadata?.onTrashed(identityId, source.path, directory, target);
      else if (source?.originalPath) {
        const original = source.originalPath;
        if (original !== target && (await missing(principal.storage, original)))
          await metadata?.onMoved(identityId, original, target, directory);
      } else if (source && source.path !== target)
        await metadata?.onMoved(identityId, source.path, target, directory);
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId, operationId: request.operationId },
        "Mac write published; its metadata follows when the indexer reports it",
      );
    }
    if (source && trashing) publish("delete", [source.path]);
    else if (source && (source.originalPath ?? source.path) !== target)
      publish("move", [source.originalPath ?? source.path], [target]);
    else publish(directory ? "mkdir" : "create", [target]);
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
  function spool(principal: Principal, id: string) {
    if (!deps.stateDir) throw new ApiHttpError("forbidden", "Desktop writes are disabled");
    return join(deps.stateDir, principal.identityId, id);
  }
  /** The verified body `upload` spooled for this operation. */
  function spooled(principal: Principal, op: DesktopOperationRecord) {
    const uploadFile = op.result?.uploadFile;
    if (typeof uploadFile !== "string" || !UUID.test(uploadFile))
      throw Error("Missing upload receipt");
    const local = join(spool(principal, op.id), uploadFile);
    return () => Readable.toWeb(createReadStream(local)) as ReadableStream<Uint8Array>;
  }
  /** Where an operation stages its in-place save, beside the rest of the Mac's bookkeeping. */
  const staging = (principal: Principal, id: string) =>
    `${DESKTOP_INTERNAL_ROOT}/${principal.identityId}/${id}`;
  /**
   * Copies an in-place save's spooled body into the files folder, at a path
   * keyed by operation and attempt that no other operation reaches, so the
   * rename that publishes it is one step. A retry reuses the attempt and
   * what it staged. Nothing there is hashed again: `upload` verified the
   * body's digest as it arrived, and the copy is checked by its length.
   */
  async function stage(
    principal: Principal,
    op: DesktopOperationRecord,
    size: number,
    body: () => ReadableStream<Uint8Array>,
  ) {
    const storage = principal.storage;
    const attempt =
      typeof op.result?.remoteAttempt === "string" ? op.result.remoteAttempt : randomUUID();
    if (!UUID.test(attempt)) throw Error("Invalid staging receipt");
    if (
      !(await transition(principal, op.id, "committing", "committing", {
        ...op.result,
        remoteAttempt: attempt,
      }))
    )
      throw Error("Could not reserve staging");
    const internal = `${staging(principal, op.id)}/${attempt}`;
    await storage.mkdir(internal, { parents: true });
    const path = `${internal}/incoming`;
    const staged = (await storage.list(internal)).find((item) => item.path === path);
    if (staged && staged.kind !== "file")
      throw new ApiHttpError("forbidden", "Unsupported staging entry");
    await storage.upload(path, body(), { overwrite: !!staged, contentLength: size });
    return { path, internal };
  }
  /**
   * Removes the folders an in-place save staged in, empty once its rename
   * published the file. Never recursive, so nothing that arrived there
   * since goes with them; anything left waits for retention.
   */
  async function tidy(principal: Principal, id: string, internal: string) {
    try {
      await principal.storage.deleteEmptyDir(internal);
      await principal.storage.deleteEmptyDir(staging(principal, id));
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId: principal.identityId, operationId: id },
        "Mac save published; its staging folder stays until retention removes it",
      );
    }
  }
  /**
   * Takes the old name of a save that also renamed its file away, to fdrive's
   * Trash like any delete, but only while it is still the file the save was
   * based on. A file someone wrote there since stays where it is.
   */
  async function retire(principal: Principal, path: string, witness: ContentStamp, id: string) {
    try {
      await unchanged(principal.storage, path, witness);
      await principal.storage.deleteFile(path);
    } catch (error) {
      deps.logger?.warn(
        { err: error, identityId: principal.identityId, operationId: id },
        "Mac save published under its new name; the old name stays",
      );
    }
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
      return status(prior);
    }
    if (request.kind === "upload") {
      if (request.size > DESKTOP_MAX_UPLOAD_BYTES)
        throw new ApiHttpError("bad_request", "File exceeds the 16 GiB upload limit", {
          code: "quota_exceeded",
        });
      if (!!request.itemId !== !!request.base)
        throw new ApiHttpError("bad_request", "Updates require an item and base version");
    }
    const parent = await record(principal, request.parentId);
    const source =
      "itemId" in request && request.itemId ? await record(principal, request.itemId) : undefined;
    if (request.kind === "upload" && source && inTrash(principal, source.path))
      throw new ApiHttpError("forbidden", "Restore this item before editing it");
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
        activityPath: source?.path ?? `${parent.path === "/" ? "" : parent.path}/${request.name}`,
        activityTarget: `${parent.path === "/" ? "" : parent.path}/${request.name}`,
        activityKind: source?.kind === "dir" || request.kind === "folder" ? "dir" : "file",
        activityAction:
          request.kind === "folder"
            ? "folder.create"
            : request.kind === "upload"
              ? source
                ? "file.save"
                : "file.create"
              : request.parentId === "trash"
                ? "file.trash"
                : source?.originalPath
                  ? "file.restore"
                  : source && parentPath(source.path) === parent.path
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
    availability,
    decorate,
    files: {
      async content(principal: Principal, path: string, signal: AbortSignal) {
        const physical = physicalTrashPath(principal, path);
        if (!physical) return files.content(principal, path, signal);
        const entry = await trashEntry(principal, physical);
        if (entry.kind !== "file")
          throw new ApiHttpError("bad_request", "Only files can be downloaded");
        return runStorageCall(() => principal.storage.download(physical, { signal }));
      },
      async versions(principal: Principal, paths: string[], signal: AbortSignal) {
        // Every file outside Trash in one call, so their index rows come in one lookup.
        const live = paths.filter((path) => !physicalTrashPath(principal, path));
        const answered =
          live.length === 0 ? [] : (await files.versions(principal, live, signal)).items;
        if (live.length === paths.length) return { items: answered };
        const outside = answered.values();
        const items = [];
        for (const path of paths) {
          const physical = physicalTrashPath(principal, path);
          // `files.versions` answered every path outside Trash, in order.
          if (!physical) {
            items.push(outside.next().value as (typeof answered)[number]);
            continue;
          }
          const entry = await trashEntry(principal, physical);
          if (entry.kind !== "file")
            throw new ApiHttpError("bad_request", "Only files have content versions");
          const value = await runStorageCall(() => digestFile(principal.storage, physical, signal));
          items.push({ path, size: value.size, version: value.sha256 });
        }
        return { items };
      },
    },
    async list(principal: Principal, path: string, tokenKey: string, cursor?: string) {
      const physical = physicalTrashPath(principal, path);
      if (path === DESKTOP_TRASH || physical) {
        if (cursor) throw new ApiHttpError("conflict", "Refresh Trash to restart the listing");
        if (physical) await trashEntry(principal, physical);
        const items = physical
          ? await runStorageCall(() => principal.storage.list(physical))
          : await repo.children(principal.identityId, trashRoot(principal));
        if (items.length > 100_000)
          throw new ApiHttpError("rate_limited", "Trash listing capacity reached");
        const entries: DesktopEntry[] = [];
        for (const item of items) {
          try {
            entries.push(await trashEntry(principal, item.path));
          } catch (error) {
            if (!(error instanceof ApiHttpError && ["not_found", "forbidden"].includes(error.kind)))
              throw error;
          }
        }
        return { entries: await decorateMany(principal, entries), nextCursor: null };
      }
      const result = await files.list(principal, path, tokenKey, cursor);
      const entries = await decorateMany(principal, result.entries);
      return {
        entries,
        nextCursor: result.nextCursor,
        ...(!cursor && result.nextCursor === null ? { token: listingToken(entries) } : {}),
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
      const physical = physicalTrashPath(principal, path);
      return decorate(
        principal,
        physical ? await trashEntry(principal, physical) : await files.stat(principal, path),
      );
    },
    prepare,
    async status(principal: Principal, id: string) {
      return status(await operation(principal, id));
    },
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
      const directory = spool(principal, id);
      let file: FileHandle | undefined;
      let verified = false;
      const reader = body.getReader();
      const sha = createHash("sha256");
      let size = 0;
      const timeout = AbortSignal.any([
        signal,
        controller.signal,
        AbortSignal.timeout(30 * 60_000),
      ]);
      const abort = () => {
        void reader.cancel(timeout.reason).catch(() => undefined);
      };
      timeout.addEventListener("abort", abort, { once: true });
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        file = await open(join(directory, attempt), "wx", 0o600);
        for (;;) {
          timeout.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > request.size)
            throw new ApiHttpError("bad_request", "Upload exceeds its declared length", {
              code: "invalid_upload",
            });
          sha.update(next.value);
          // FileHandle.write can make a short write.
          let offset = 0;
          while (offset < next.value.byteLength) {
            const written = await file.write(next.value, offset);
            if (written.bytesWritten === 0) throw Error("Upload spool stopped accepting bytes");
            offset += written.bytesWritten;
          }
        }
        timeout.throwIfAborted();
        if (size !== request.size || sha.digest("hex") !== request.sha256)
          throw new ApiHttpError("bad_request", "Upload length or digest does not match", {
            code: "invalid_upload",
          });
        await file.sync();
        await file.close();
        const dir = await open(directory, "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
        verified = true;
        if (
          !(await transition(principal, id, "uploading", "ready", { uploadFile: attempt }, attempt))
        )
          throw new ApiHttpError("conflict", "Upload attempt was superseded");
      } catch (error) {
        await file?.close().catch(() => undefined);
        // A database response can be lost after the ready transition committed.
        // Never unlink the payload named by a durable (or uncertain) receipt.
        const current = await operation(principal, id).catch(() => null);
        if (verified && current?.state === "ready" && current.result?.uploadFile === attempt)
          return status(current);
        const reset = await transition(principal, id, "uploading", "receiving", {}, attempt).catch(
          () => false,
        );
        if (
          reset ||
          (current?.state === "uploading" && current.result?.attempt !== attempt) ||
          (current?.state === "ready" && current.result?.uploadFile !== attempt)
        )
          await rm(join(directory, attempt), { force: true }).catch(() => undefined);
        throw error;
      } finally {
        if (uploads.get(uploadKey) === controller) uploads.delete(uploadKey);
        timeout.removeEventListener("abort", abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return status(await operation(principal, id));
    },
    async commit(principal: Principal, id: string) {
      authority(principal);
      const op = await operation(principal, id);
      if (op.state !== "ready") return status(op);
      if (!(await transition(principal, id, "ready", "committing")))
        return status(await operation(principal, id));
      const request = op.request as Request;
      const storage = principal.storage;
      // Set once a failure can no longer tell whether the write reached storage.
      let started = false;
      const trashing = request.parentId === "trash";
      let published: {
        receipt: DesktopOperationResult;
        source?: DesktopItemRecord;
        target: string;
      };
      /**
       * Runs the one storage call that publishes the write. A `conflict` from
       * it wrote nothing: storage refuses a taken name before writing, so a
       * name taken since `unoccupied` looked is the client's collision. With
       * `linkedLast` no failure wrote anything: the call publishes as its last
       * step.
       */
      const publish = async (run: () => Promise<void>, linkedLast = false) => {
        started = !linkedLast;
        try {
          await run();
        } catch (error) {
          if (!(isStorageError(error) && error.kind === "conflict")) throw error;
          started = false;
          fail("name_collision", COLLISION);
        }
        started = true;
      };
      try {
        const parent = await record(principal, request.parentId);
        const source =
          "itemId" in request && request.itemId
            ? await record(principal, request.itemId)
            : undefined;
        if (trashing && (request.kind !== "move" || !source || inTrash(principal, source.path)))
          throw new ApiHttpError("bad_request", "Only existing items can be moved to Trash");
        if (request.kind === "upload" && source && inTrash(principal, source.path))
          throw new ApiHttpError("forbidden", "Restore this item before editing it");
        if (request.kind === "upload" && source && source.kind !== "file")
          throw new ApiHttpError("bad_request", "Only regular files can be replaced");
        const name =
          source?.originalPath && request.name === trashName(source)
            ? (source.originalPath.split("/").at(-1) as string)
            : request.name;
        const target =
          trashing && source
            ? `${trashRoot(principal)}/${source.id}`
            : await unoccupied(principal, parent, name, source?.path);
        // What the source must still be when it is published over or moved.
        const witness =
          source && "base" in request && request.base
            ? await checkBase(principal, source, request.base, request.kind === "upload")
            : null;
        if (source && isUnderPath(source.path, target))
          throw new ApiHttpError("bad_request", "Cannot move a folder into itself");
        const access = await accessMove(principal, source, source?.path, target);
        if (request.kind === "upload") {
          const body = spooled(principal, op);
          if (source && witness && source.path === target) {
            // A save in place: staged, then renamed over the original once its
            // stamp shows nobody wrote it since the base was proven.
            const staged = await stage(principal, op, request.size, body);
            await unchanged(storage, source.path, witness);
            await publish(() => storage.move(staged.path, target, { overwrite: true }));
            await tidy(principal, id, staged.internal);
          } else {
            // A new name, which the files folder links into place only while it
            // is free, so of two creates racing for it one is refused. It
            // writes beside the name and links last, so a failed upload
            // published nothing.
            if (source && witness) await unchanged(storage, source.path, witness);
            await publish(
              () =>
                storage.upload(target, body(), { overwrite: false, contentLength: request.size }),
              true,
            );
            if (source && witness) await retire(principal, source.path, witness, id);
          }
        } else if (request.kind === "folder") {
          await publish(() => storage.mkdir(target));
        } else if (source) {
          if (trashing) await storage.mkdir(trashRoot(principal), { parents: true });
          if (source.path !== target) {
            await (witness
              ? unchanged(storage, source.path, witness, true)
              : stillFolder(storage, source.path));
            await publish(() => storage.move(source.path, target, { overwrite: false }));
          }
        }
        if (source) await repo.move(principal.identityId, source.path, target);
        if (source && (trashing || inTrash(principal, source.path)))
          await repo.update(principal.identityId, source.id, {
            originalPath: trashing ? source.path : null,
          });
        const entry = trashing
          ? await trashEntry(principal, target)
          : await files.stat(principal, target);
        const item = await decorate(
          principal,
          entry,
          request.kind === "upload" ? request.sha256 : undefined,
        );
        const receipt: DesktopOperationResult = {
          operationId: id,
          state: "completed",
          item,
          recoveryId: null,
        };
        const facts = activityFacts(principal, request, source, target, trashing);
        if (
          !(await repo.complete(
            principal.identityId,
            principal.accountId,
            id,
            receipt,
            facts,
            access,
          ))
        )
          throw Error("Could not persist commit receipt");
        published = { receipt, ...(source ? { source } : {}), target };
      } catch (error) {
        const conflict = error instanceof ApiHttpError && error.kind === "conflict";
        const state = started ? "uncertain" : conflict ? "conflict" : "ready";
        await transition(principal, id, "committing", state);
        if (started)
          fail(
            "operation_uncertain",
            "Commit could not be confirmed. The pending file is preserved; do not retry with a new operation ID.",
          );
        if (error instanceof StorageError) throw new ApiHttpError(error.kind, error.message);
        throw error;
      }
      await follow(principal, request, published.source, published.target, trashing);
      return published.receipt;
    },
    /** Commits without a receipt, oldest first, for administrator inspection. */
    async uncertain(now: Date) {
      return (await repo.uncertain(100)).map((op) => {
        const request = op.request as Request;
        return {
          identityId: op.identityId,
          operationId: op.id,
          state: op.state as "committing" | "uncertain",
          stalled:
            op.state === "uncertain" ||
            now.getTime() - op.updatedAt.getTime() > DESKTOP_COMMIT_STALL_MS,
          kind: request.kind,
          name: request.name,
          updatedAt: op.updatedAt.toISOString(),
        };
      });
    },
    /** The administrator inspected storage. `published` records the receipt from the
     * current target and brings metadata along; `discarded` cancels without touching
     * storage or spool (retention removes them later). Never replays a write. */
    async resolve(
      identityId: string,
      accountId: string,
      id: string,
      outcome: "published" | "discarded",
      now: Date,
    ): Promise<DesktopOperationResult> {
      const op = await repo.operation(identityId, accountId, id);
      if (!op) throw new ApiHttpError("not_found", "Operation is not available");
      const stalled =
        op.state === "uncertain" ||
        (op.state === "committing" &&
          now.getTime() - op.updatedAt.getTime() > DESKTOP_COMMIT_STALL_MS);
      if (!stalled)
        throw new ApiHttpError("conflict", "Only an uncertain or stalled commit can be resolved");
      if (outcome === "discarded") {
        if (!(await repo.transition(identityId, accountId, id, op.state, "cancelled")))
          throw new ApiHttpError("conflict", "Operation changed while resolving");
        const cancelled = await repo.operation(identityId, accountId, id);
        if (!cancelled) throw new ApiHttpError("not_found", "Operation is not available");
        return status(cancelled);
      }
      if (!deps.storageForIdentity)
        throw new ApiHttpError("upstream_unavailable", "Recovery resolution is unavailable");
      const storage = await deps.storageForIdentity(identityId);
      const principal: Principal = {
        accountId,
        identityId,
        username: "administrator",
        isAdmin: true,
        storage,
        tokenAccess: { mode: "full", paths: ["/"] },
      };
      const request = op.request as Request;
      const parent = await record(principal, request.parentId);
      const source =
        "itemId" in request && request.itemId ? await repo.item(identityId, request.itemId) : null;
      if ("itemId" in request && request.itemId && !source)
        throw new ApiHttpError("conflict", "The source handle no longer exists; choose discarded");
      const trashing = request.parentId === "trash";
      const name =
        source?.originalPath && request.name === trashName(source)
          ? (source.originalPath.split("/").at(-1) as string)
          : request.name;
      const target =
        trashing && source
          ? `${trashRoot(principal)}/${source.id}`
          : `${parent.path === "/" ? "" : parent.path}/${name}`;
      // Storage evidence is checked before any registry change.
      const missing = new ApiHttpError(
        "conflict",
        "Nothing was published at the target; choose discarded",
      );
      let entry: DesktopEntry | undefined;
      if (trashing) {
        const listed = await storage.list(trashRoot(principal)).catch(() => []);
        if (!listed.some((candidate) => candidate.path === target)) throw missing;
      } else {
        try {
          entry = await files.stat(principal, target);
        } catch (error) {
          if (error instanceof ApiHttpError && error.kind === "not_found") throw missing;
          throw error;
        }
        if (request.kind === "upload" && entry.kind !== "file")
          throw new ApiHttpError("conflict", "The target is not a file; choose discarded");
        if (
          request.kind === "upload" &&
          (await digestFile(storage, target)).sha256 !== request.sha256
        )
          throw new ApiHttpError(
            "conflict",
            "The target's bytes differ from the upload; choose discarded",
          );
      }
      // Registry updates that the interrupted commit may not have reached.
      if (source && source.path !== target) await repo.move(identityId, source.path, target);
      if (source && trashing)
        await repo.update(identityId, source.id, { originalPath: source.path });
      else if (source?.originalPath && !inTrash(principal, target))
        await repo.update(identityId, source.id, { originalPath: null });
      entry ??= await trashEntry(principal, target);
      // From where the item was when the write was prepared: the interrupted
      // commit may have moved the registry already, never what grants access.
      const preparedAt = op.request.activityPath;
      const access = await accessMove(
        principal,
        source,
        typeof preparedAt === "string" ? preparedAt : source?.path,
        target,
      );
      const item = await decorate(
        principal,
        entry,
        request.kind === "upload" ? request.sha256 : undefined,
      );
      const result: DesktopOperationResult = {
        operationId: id,
        state: "completed",
        item,
        recoveryId: null,
      };
      if (
        op.state === "uncertain" &&
        !(await repo.transition(identityId, accountId, id, "uncertain", "committing"))
      )
        throw new ApiHttpError("conflict", "Operation changed while resolving");
      const facts = activityFacts(principal, request, source, target, trashing);
      if (!(await repo.complete(identityId, accountId, id, result, facts, access)))
        throw new ApiHttpError("conflict", "Operation changed while resolving");
      await follow(principal, request, source, target, trashing);
      return result;
    },
    async acknowledge(principal: Principal, id: string) {
      const op = await operation(principal, id);
      if (!["completed", "acknowledged"].includes(op.state))
        throw new ApiHttpError("conflict", "Only a completed operation can be acknowledged");
      // Receipts remain queryable indefinitely, independently of payload cleanup.
      await transition(principal, id, "completed", "acknowledged");
      await rm(spool(principal, id), { recursive: true, force: true });
      return status(op);
    },
    async cancel(principal: Principal, id: string) {
      const op = await operation(principal, id);
      if (op.state === "cancelled") return status(op);
      if (!["receiving", "ready", "conflict"].includes(op.state))
        throw new ApiHttpError("conflict", "An active or uncertain commit cannot be discarded");
      if (await transition(principal, id, op.state, "cancelled"))
        await rm(spool(principal, id), { recursive: true, force: true });
      return status(await operation(principal, id));
    },
  };
}
export type DesktopWrites = ReturnType<typeof createDesktopWrites>;
