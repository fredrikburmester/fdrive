import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
  DesktopBaseVersion,
  DesktopEntry,
  DesktopFolderRequest,
  DesktopMoveRequest,
  DesktopOperationResult,
  DesktopUploadRequest,
  DesktopWriteCapabilities,
  DesktopWriteEntry,
} from "@fdrive/contracts";
import { isUnderPath, parentPath, StorageError, type StorageProvider } from "@fdrive/core";
import type {
  DesktopEffectContext,
  DesktopItemRecord,
  DesktopOperationRecord,
  DesktopRepo,
} from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { runStorageCall } from "../fs/routes.js";
import { createDesktopFiles, DESKTOP_INTERNAL_ROOT } from "./files.js";
import type { DesktopDeps } from "./pairing.js";

export const DESKTOP_MAX_UPLOAD_BYTES = 16 * 1024 ** 3;
export const NO_WRITES: DesktopWriteCapabilities = {
  create: false,
  update: false,
  move: false,
  trash: false,
  restore: false,
};
export const DESKTOP_TRASH = `${DESKTOP_INTERNAL_ROOT}/trash`;
type Request =
  | (DesktopUploadRequest & { kind: "upload" })
  | (DesktopFolderRequest & { kind: "folder" })
  | (DesktopMoveRequest & { kind: "move" });
export interface DesktopWriteDeps extends Pick<DesktopDeps, "clock" | "trashPathForStorage"> {
  repo: DesktopRepo;
  stateDir?: string;
  effectContext?: (
    principal: Principal,
    context: Omit<DesktopEffectContext, "office">,
  ) => Promise<DesktopEffectContext>;
  effects?: { beforeWrite(identityId: string): Promise<void>; kick(): void };
  /** Administrator resolution of uncertain commits needs the identity's storage. */
  storageForIdentity?: (identityId: string) => Promise<StorageProvider>;
}
/** A commit that has not progressed for this long is treated as abandoned by its process. */
export const DESKTOP_COMMIT_STALL_MS = 15 * 60_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string, message: string): never {
  throw new ApiHttpError("conflict", message, { code });
}
const collisionName = (value: string) => value.normalize("NFC").toLowerCase();

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
  function capabilities(principal: Principal): DesktopWriteCapabilities {
    return deps.stateDir &&
      principal.tokenAccess?.mode === "full" &&
      principal.storage.withWriteLease
      ? { create: true, update: true, move: true, trash: true, restore: true }
      : NO_WRITES;
  }
  async function authority(principal: Principal) {
    if (!capabilities(principal).create)
      throw new ApiHttpError("forbidden", "This location cannot enforce safe writes", {
        code: "unsupported",
      });
    if (principal.verifyAuthority && !(await principal.verifyAuthority()))
      throw new ApiHttpError("unauthorized", "Connection was revoked");
  }
  async function record(principal: Principal, id: string) {
    if (id === "trash") return repo.ensure(principal.identityId, trashRoot(principal), "dir");
    const result =
      id === "root"
        ? await repo.ensure(principal.identityId, "/", "dir")
        : await repo.item(principal.identityId, id);
    if (!result) throw new ApiHttpError("not_found", "Item no longer exists");
    if (inTrash(principal, result.path)) await trashEntry(principal, result.path);
    else await files.stat(principal, result.path);
    return result;
  }
  async function decorate(
    principal: Principal,
    entry: DesktopEntry,
    content?: string,
  ): Promise<DesktopWriteEntry> {
    const item = await repo.ensure(principal.identityId, entry.path, entry.kind);
    const parent =
      entry.path === "/"
        ? item
        : await repo.ensure(principal.identityId, parentPath(entry.path), "dir");
    const metadata = hash([
      item.metadataVersion,
      entry.path,
      entry.kind,
      entry.size,
      entry.modifiedAt,
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
  async function internalDirectory(storage: StorageProvider, path: string) {
    let parent = "/";
    for (const name of path.slice(1).split("/")) {
      const next = `${parent === "/" ? "" : parent}/${name}`;
      const item = (await storage.list(parent)).find((item) => item.path === next);
      if (item && item.kind !== "dir")
        throw new ApiHttpError("forbidden", "Recovery path is not a regular directory");
      if (!item) await storage.mkdir(next);
      parent = next;
    }
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
    let parent = "/";
    let result: DesktopEntry | undefined;
    for (const name of path.slice(1).split("/")) {
      const next = `${parent === "/" ? "" : parent}/${name}`;
      const entry = (await runStorageCall(() => principal.storage.list(parent))).find(
        (entry) => entry.path === next,
      );
      if (!entry) throw new ApiHttpError("not_found", "Trashed item no longer exists");
      if (entry.kind === "symlink" || (next !== path && entry.kind !== "dir"))
        throw new ApiHttpError("forbidden", "Unsupported recovery path");
      result = {
        ...entry,
        modifiedAt: entry.modifiedAt.toISOString(),
        readable: entry.kind === "dir" || entry.kind === "file",
      };
      parent = next;
    }
    return result as DesktopEntry;
  }
  function physicalTrashPath(principal: Principal, path: string) {
    if (!isUnderPath(DESKTOP_TRASH, path)) return null;
    return trashRoot(principal) + path.slice(DESKTOP_TRASH.length);
  }
  async function digest(storage: StorageProvider, path: string, signal?: AbortSignal) {
    const download = await storage.download(path, signal ? { signal } : undefined);
    const reader = download.body.getReader();
    const sha = createHash("sha256");
    let size = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        sha.update(next.value);
        size += next.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (download.contentLength !== null && size !== download.contentLength)
      throw new ApiHttpError("upstream_unavailable", "Incomplete content validation");
    return { sha256: sha.digest("hex"), size };
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
    const candidates = await principal.storage.list(parent.path);
    if (
      candidates.some(
        (item) => collisionName(item.name) === collisionName(name) && item.path !== source,
      )
    )
      fail("name_collision", "An item with this name already exists");
    return `${parent.path === "/" ? "" : parent.path}/${name}`;
  }
  async function checkBase(
    principal: Principal,
    item: DesktopItemRecord,
    base: DesktopBaseVersion,
    contentRequired: boolean,
  ) {
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
    if (
      live.kind === "file" &&
      (contentRequired || /^[a-f0-9]{64}$/.test(base.content)) &&
      (await digest(principal.storage, item.path)).sha256 !== base.content
    )
      fail("version_conflict", "This file changed remotely. Your pending copy is preserved.");
    return live;
  }
  async function operation(principal: Principal, id: string) {
    const result = await repo.operation(principal.identityId, principal.accountId, id);
    if (!result) throw new ApiHttpError("not_found", "Operation is not available");
    return result;
  }
  function status(op: DesktopOperationRecord): DesktopOperationResult {
    if (op.state === "completed" || op.state === "acknowledged")
      return op.result as unknown as DesktopOperationResult;
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
  async function prepare(principal: Principal, request: Request) {
    await authority(principal);
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
    await record(principal, request.parentId);
    const source =
      "itemId" in request && request.itemId ? await record(principal, request.itemId) : undefined;
    // Include both the incoming body and retained originals. This reservation
    // survives acknowledgement: backups are never purged to admit another save.
    const sourceSize =
      request.kind === "upload" && source ? (await files.stat(principal, source.path)).size : 0;
    const recoveryBytes = request.kind === "upload" ? 2 * sourceSize : 0;
    let op: DesktopOperationRecord;
    try {
      op = await repo.reserve({
        id: request.operationId,
        identityId: principal.identityId,
        accountId: principal.accountId,
        requestHash: hash(request),
        request: { ...request, recoveryBytes },
        state: request.kind === "upload" ? "receiving" : "ready",
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Desktop recovery capacity reached")
        throw new ApiHttpError("rate_limited", error.message, { code: "quota_exceeded" });
      throw error;
    }
    if (op.requestHash !== hash(request))
      throw new ApiHttpError("conflict", "Operation ID was reused with different contents");
    return status(op);
  }
  return {
    capabilities,
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
        const items = [];
        for (const path of paths) {
          const physical = physicalTrashPath(principal, path);
          if (physical) {
            const entry = await trashEntry(principal, physical);
            if (entry.kind !== "file")
              throw new ApiHttpError("bad_request", "Only files have content versions");
            const value = await runStorageCall(() => digest(principal.storage, physical, signal));
            items.push({ path, size: value.size, version: value.sha256 });
          } else items.push(...(await files.versions(principal, [path], signal)).items);
        }
        return { items };
      },
    },
    async list(principal: Principal, path: string, tokenKey: string, cursor?: string) {
      const physical = physicalTrashPath(principal, path);
      if (path === DESKTOP_TRASH || physical) {
        if (cursor) throw new ApiHttpError("conflict", "Refresh Trash to restart the listing");
        const items = physical
          ? await runStorageCall(async () =>
              principal.storage.list((await trashEntry(principal, physical)).path),
            )
          : await repo.children(principal.identityId, trashRoot(principal));
        if (items.length > 100_000)
          throw new ApiHttpError("rate_limited", "Trash listing capacity reached");
        const entries: DesktopWriteEntry[] = [];
        for (const item of items) {
          try {
            entries.push(await decorate(principal, await trashEntry(principal, item.path)));
          } catch (error) {
            if (!(error instanceof ApiHttpError && ["not_found", "forbidden"].includes(error.kind)))
              throw error;
          }
        }
        return { entries, nextCursor: null };
      }
      const result = await files.list(principal, path, tokenKey, cursor);
      return {
        entries: await Promise.all(result.entries.map((entry) => decorate(principal, entry))),
        nextCursor: result.nextCursor,
      };
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
      await authority(principal);
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
      await authority(principal);
      const op = await operation(principal, id);
      if (op.state !== "ready") return status(op);
      if (!(await transition(principal, id, "ready", "committing")))
        return status(await operation(principal, id));
      const request = op.request as Request;
      let publicationStarted = false;
      try {
        const receipt = await principal.storage.withWriteLease?.(async (storage) => {
          const scoped = { ...principal, storage };
          // Re-prove authorization immediately before the storage operation. The scoped
          // adapter intentionally has no reusable lease method of its own.
          await authority(principal);
          await deps.effects?.beforeWrite(principal.identityId);
          const parent = await record(scoped, request.parentId);
          const source =
            "itemId" in request && request.itemId
              ? await record(scoped, request.itemId)
              : undefined;
          const trashing = request.parentId === "trash";
          if (trashing && (request.kind !== "move" || !source || inTrash(principal, source.path)))
            throw new ApiHttpError("bad_request", "Only existing items can be moved to Trash");
          if (request.kind === "upload" && source && inTrash(principal, source.path))
            throw new ApiHttpError("forbidden", "Restore this item before editing it");
          const target =
            trashing && source
              ? `${trashRoot(principal)}/${source.id}`
              : await unoccupied(
                  scoped,
                  parent,
                  source?.originalPath && request.name === trashName(source)
                    ? (source.originalPath.split("/").at(-1) as string)
                    : request.name,
                  source?.path,
                );
          if (source && "base" in request && request.base)
            await checkBase(scoped, source, request.base, request.kind === "upload");
          if (source && isUnderPath(source.path, target))
            throw new ApiHttpError("bad_request", "Cannot move a folder into itself");
          const context: Omit<DesktopEffectContext, "office"> = {
            from: source?.originalPath ?? source?.path ?? null,
            to: trashing ? DESKTOP_TRASH + target.slice(trashRoot(principal).length) : target,
            directory: request.kind === "folder" || source?.kind === "dir",
            trash: trashing,
          };
          if (
            context.from &&
            context.from !== context.to &&
            !trashing &&
            (context.to.startsWith(context.from + "/") || context.from.startsWith(context.to + "/"))
          )
            fail(
              "unsupported",
              "Restore this item outside its original folder hierarchy to preserve metadata.",
            );
          const effectContext = deps.effectContext
            ? await deps.effectContext(principal, context)
            : { ...context, office: null };
          const effects = await repo.captureEffects(
            principal.identityId,
            principal.accountId,
            effectContext,
          );
          let recoveryId: string | null = null;
          if (request.kind === "upload") {
            if (source && source.kind !== "file")
              throw new ApiHttpError("bad_request", "Only regular files can be replaced");
            // One namespace per identity, never a client-selected internal path. A
            // staging PUT can fail or be partial without touching the visible source.
            const remoteAttempt =
              typeof op.result?.remoteAttempt === "string" ? op.result.remoteAttempt : randomUUID();
            if (!/^[a-f0-9-]{36}$/.test(remoteAttempt)) throw Error("Invalid recovery receipt");
            const uploadReceipt = { ...op.result, remoteAttempt };
            if (!(await transition(principal, id, "committing", "committing", uploadReceipt)))
              throw Error("Could not reserve remote recovery");
            const internal = `${DESKTOP_INTERNAL_ROOT}/${principal.identityId}/${id}/${remoteAttempt}`;
            await internalDirectory(storage, internal);
            const stage = `${internal}/incoming`;
            const uploadFile = op.result?.uploadFile;
            if (typeof uploadFile !== "string" || !/^[a-f0-9-]{36}$/.test(uploadFile))
              throw Error("Missing upload receipt");
            const local = join(spool(principal, id), uploadFile);
            const staged = (await storage.list(internal)).find((item) => item.path === stage);
            if (staged && staged.kind !== "file")
              throw new ApiHttpError("forbidden", "Unsupported staging entry");
            await storage.upload(
              stage,
              Readable.toWeb(createReadStream(local)) as ReadableStream<Uint8Array>,
              { overwrite: !!staged, contentLength: request.size },
            );
            const verified = await digest(storage, stage);
            if (verified.size !== request.size || verified.sha256 !== request.sha256)
              throw Error("Staged content failed validation");
            if (source) {
              recoveryId = id;
              const previous = (await storage.list(internal)).find(
                (item) => item.path === `${internal}/previous`,
              );
              if (previous && previous.kind !== "file")
                throw new ApiHttpError("forbidden", "Unsupported recovery entry");
              if (!previous)
                await storage.copy(source.path, `${internal}/previous`, { overwrite: false });
              const backup = await digest(storage, `${internal}/previous`);
              if (backup.sha256 !== request.base?.content)
                throw Error("Recovery copy failed validation");
            }
            await authority(principal);
            // Publication is the only operation allowed to replace the original.
            // Apache evaluates the source/destination lease tokens atomically.
            publicationStarted = true;
            await storage.move(stage, target, { overwrite: source?.path === target });
            // Combined save+rename keeps the old source recoverable until the new
            // contents are published. Moving it to recovery never overwrites a peer.
            if (source && source.path !== target)
              await storage.move(source.path, `${internal}/renamed-original`, { overwrite: false });
          } else if (request.kind === "folder") {
            await authority(principal);
            publicationStarted = true;
            await storage.mkdir(target);
          } else if (source) {
            if (trashing) await internalDirectory(storage, trashRoot(principal));
            if (source.path !== target) {
              await authority(principal);
              publicationStarted = true;
              await storage.move(source.path, target, { overwrite: false });
            }
          }
          if (source) await repo.move(principal.identityId, source.path, target);
          if (source && (trashing || inTrash(principal, source.path)))
            await repo.update(principal.identityId, source.id, {
              originalPath: trashing ? source.path : null,
            });
          const entry = trashing
            ? await trashEntry(scoped, target)
            : await files.stat(scoped, target);
          // Use the original principal for the capability intersection.
          const item = await decorate(
            principal,
            entry,
            request.kind === "upload" ? request.sha256 : undefined,
          );
          const result: DesktopOperationResult = {
            operationId: id,
            state: "completed",
            item,
            recoveryId,
          };
          if (
            !(await repo.complete(principal.identityId, principal.accountId, id, result, effects))
          )
            throw Error("Could not persist commit receipt");
          return result;
        });
        if (!receipt) throw Error("Write lease is unavailable");
        // The durable queue owns failures after the receipt commits.
        try {
          deps.effects?.kick();
        } catch {
          /* Startup/timer recovery will retry. */
        }
        return receipt;
      } catch (error) {
        const conflict = error instanceof ApiHttpError && error.kind === "conflict";
        const state = publicationStarted ? "uncertain" : conflict ? "conflict" : "ready";
        await transition(principal, id, "committing", state);
        if (publicationStarted)
          fail(
            "operation_uncertain",
            "Commit could not be confirmed. The pending file and recovery copies are preserved; do not retry with a new operation ID.",
          );
        if (
          error instanceof Error &&
          error.message === "Desktop metadata recovery capacity reached"
        )
          throw new ApiHttpError("rate_limited", error.message, { code: "quota_exceeded" });
        if (error instanceof StorageError) throw new ApiHttpError(error.kind, error.message);
        throw error;
      }
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
     * current target and queues metadata recovery; `discarded` cancels without touching
     * storage, spool or backups (retention reclaims them later). Never replays a write. */
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
        if (request.kind === "upload" && (await digest(storage, target)).sha256 !== request.sha256)
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
      const context: Omit<DesktopEffectContext, "office"> = {
        from: source?.originalPath ?? source?.path ?? null,
        to: trashing ? DESKTOP_TRASH + target.slice(trashRoot(principal).length) : target,
        directory: request.kind === "folder" || source?.kind === "dir",
        trash: trashing,
      };
      const effectContext = deps.effectContext
        ? await deps.effectContext(principal, context)
        : { ...context, office: null };
      const effects = await repo.captureEffects(identityId, accountId, effectContext);
      const item = await decorate(
        principal,
        entry,
        request.kind === "upload" ? request.sha256 : undefined,
      );
      const result: DesktopOperationResult = {
        operationId: id,
        state: "completed",
        item,
        recoveryId: request.kind === "upload" && source ? id : null,
      };
      if (
        op.state === "uncertain" &&
        !(await repo.transition(identityId, accountId, id, "uncertain", "committing"))
      )
        throw new ApiHttpError("conflict", "Operation changed while resolving");
      if (!(await repo.complete(identityId, accountId, id, result, effects)))
        throw new ApiHttpError("conflict", "Operation changed while resolving");
      try {
        deps.effects?.kick();
      } catch {
        /* Startup/timer recovery will retry. */
      }
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
