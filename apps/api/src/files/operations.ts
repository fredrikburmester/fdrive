import { randomUUID } from "node:crypto";
import type { ActivityFacts, MoveManyRequest, MoveManyResult } from "@fdrive/contracts";
import {
  baseName,
  type EntryStat,
  isStorageError,
  isUnderPath,
  type MadeFolder,
  parentPath,
  StorageError,
  type StorageProvider,
  type TrashedItem,
  trashItemPath,
  type UploadOptions,
  type UploadPartOptions,
} from "@fdrive/core";
import type { PendingTrashItem } from "@fdrive/db";
import type { ActivityCallContext } from "../activity/fs-context.ts";
import {
  type ActivityRunInput,
  activityFacts,
  activityStat,
  type PersonalActivityService,
} from "../activity/service.ts";
import type { Principal } from "../auth/principal.ts";
import { gated, ungated, type WriteGate } from "../backups/write-gate.ts";
import { ApiHttpError } from "../errors.ts";
import type { MetadataService } from "../metadata/service.ts";
import { followIntoTrash } from "../metadata/trash.ts";
import type { TrashItems } from "../trash/items.ts";
import type { AccessFollowers, OwnerPath } from "./access.ts";

/**
 * Who runs a file operation: the login whose storage it uses, and how
 * personal activity records it. A link's visitor is recorded for no one
 * (`recorded: null`), so their uploads are never the owner's history.
 */
export interface FileActor {
  readonly identityId: string;
  readonly storage: StorageProvider;
  readonly recorded: {
    readonly principal: Principal;
    readonly context: ActivityCallContext;
  } | null;
}

/** `principal` running a command recorded under `context`. */
export function fileActor(principal: Principal, context: ActivityCallContext): FileActor {
  return {
    identityId: principal.identityId,
    storage: principal.storage,
    recorded: { principal, context },
  };
}

/** What every operation reports once its storage call is done. */
export interface FileOperationDone {
  /** Set when tags, favorites or the rest could not follow; the operation stands. */
  readonly warning?: string;
  /** The personal activity event, or `pending` when history could not commit yet. */
  readonly history?: { readonly eventId: string | null; readonly pending: boolean };
}

type UploadBody = Parameters<StorageProvider["upload"]>[1];

export interface FileUploadOptions extends UploadOptions {
  readonly action: "file.upload" | "file.create" | "file.save" | "file.copy";
  /**
   * The document an editor saved from, when it is not `path`: Office's Save
   * As, recorded as a copy of it.
   */
  readonly from?: string;
}

export interface FileOperations {
  /** Uploads a file, or the last piece of one sent in several calls, and reports the file. */
  upload(
    actor: FileActor,
    path: string,
    body: UploadBody,
    options: FileUploadOptions,
  ): Promise<FileOperationDone & { entry: EntryStat }>;
  /**
   * A piece of an upload before the last: it only grows the upload's part,
   * so nothing is recorded or announced until `upload` publishes it.
   */
  uploadPart(
    actor: FileActor,
    path: string,
    body: UploadBody,
    options: UploadPartOptions,
  ): Promise<void>;
  mkdir(
    actor: FileActor,
    path: string,
    options?: { parents?: boolean },
  ): Promise<FileOperationDone & { entry: MadeFolder }>;
  /** Moves or renames an item and reports it where it is now. */
  move(
    actor: FileActor,
    path: string,
    target: string,
    options?: { action?: "file.move" | "file.rename"; createParents?: boolean },
  ): Promise<FileOperationDone & { entry: EntryStat }>;
  /** Copies an item and reports the copy. */
  copy(
    actor: FileActor,
    path: string,
    target: string,
    options?: { variant?: "duplicate" },
  ): Promise<FileOperationDone & { entry: EntryStat }>;
  /** Moves an item to Trash: its owner's, for an item in a folder shared with the login. */
  trash(actor: FileActor, path: string): Promise<FileOperationDone & { item: TrashedItem }>;
  /** Moves item `id` out of the login's Trash, to where it was deleted from unless `target`. */
  restore(
    actor: FileActor,
    id: string,
    target?: string,
  ): Promise<FileOperationDone & { entry: EntryStat }>;
  /** Deletes item `id` in the login's Trash for good; one that is not there is done. */
  purge(
    actor: FileActor,
    id: string,
    options?: { reason?: "retention" },
  ): Promise<FileOperationDone>;
}

export interface FileOperationsDeps {
  /** Absent where personal history is not wired (tests); every operation works without it. */
  readonly activity?: PersonalActivityService;
  readonly access: AccessFollowers;
  /**
   * What is kept by path without granting access: tags, favorites, folder
   * views, recents, AI chat references and the Mac's item handles. It
   * follows after the storage call, best effort.
   */
  readonly metadata?: Pick<MetadataService, "onMoved" | "onDeleted">;
  readonly ownerPath: OwnerPath;
  /**
   * The backups' write gate. Each operation holds it from its storage call
   * to its last follower, so a capture's snapshot sees all of that or none;
   * an upload, from its publish, once its body is all here. Absent, nothing
   * is held.
   */
  readonly gate?: WriteGate;
  /** What Trash holds, by its rows. */
  readonly trash: Pick<TrashItems, "begin" | "get" | "settle">;
  /** When an item went to Trash. */
  readonly clock?: () => Date;
  readonly logger?: { warn(object: Record<string, unknown>, message: string): void };
}

/** What a completed operation says when its tags and the rest could not follow it. */
function metadataWarning(done: string): string {
  return `${done}, but its tags, favorite or recent entry could not follow it.`;
}

/** Refuses a move or copy into the path's own descendant; `false` when there is nothing to do. */
function relocates(operation: "move" | "copy", path: string, target: string): boolean {
  if (isUnderPath(path, target))
    throw new StorageError("bad_request", `cannot ${operation} a path into its own descendant`);
  return path !== target;
}

/**
 * `body` as storage reads it, and whether all of it is here: a buffer is, a
 * stream once storage has read its end. The stream is read only as storage
 * reads it, so one storage refuses before reading is left as it was.
 */
function arrival(body: UploadBody): { readonly body: UploadBody; readonly done: boolean } {
  if (body instanceof Uint8Array) return { body, done: true };
  let done = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const read = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= body.getReader();
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          controller.close();
        } else controller.enqueue(chunk.value);
      },
      cancel: (reason) => (reader ?? body).cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return {
    body: read,
    get done() {
      return done;
    },
  };
}

/**
 * The one way fdrive changes files, whoever asks: the web's file and Trash
 * routes, MCP, AI chat, Office and a link's visitors. Each operation records
 * its intent, then runs its storage call in one transaction with what grants
 * access (`AccessFollowers.run`), records the outcome and lets the rest of
 * what is kept by path follow.
 *
 * What grants access fails closed: it changes before the storage call, so a
 * failure there leaves the file where it was and the request fails. No link,
 * share with people or Office file stays at a path a successful operation
 * left, and a new item there waits for them to have gone (`TouchedPaths`).
 * Trash's row changes in the same transaction: an item arrives in Trash, or
 * leaves it, with what grants access ([items.ts](../trash/items.ts)).
 *
 * No transaction, lock or gate is held while a client's body arrives: an
 * upload stages its body first and holds its path, and the backups' write
 * gate, only to publish it (`StorageProvider.upload`'s `critical`) and
 * record it.
 */
export function createFileOperations(deps: FileOperationsDeps): FileOperations {
  const gate = deps.gate ?? ungated;
  const clock = deps.clock ?? (() => new Date());

  /** Records `mutate` as one command, unless no one records it. */
  async function record<T>(
    actor: FileActor,
    input: ActivityRunInput,
    mutate: () => Promise<T>,
    facts?: (value: T) => ActivityFacts | Promise<ActivityFacts>,
  ): Promise<{ value: T; history?: FileOperationDone["history"] }> {
    const activity = deps.activity;
    const recorded = actor.recorded;
    if (activity === undefined || recorded === null) return { value: await mutate() };
    const { context } = recorded;
    const result = await activity.run(
      recorded.principal,
      {
        source: context.source,
        ...(context.producerOperationId
          ? { producerOperationId: context.producerOperationId }
          : {}),
        ...(context.batchId ? { batchId: context.batchId } : {}),
        ...(context.bridge ? { bridge: context.bridge } : {}),
        ...input,
      },
      mutate,
      facts,
    );
    return {
      value: result.value,
      history: { eventId: result.eventId, pending: result.historyPending },
    };
  }

  /** The chat that proposed the command, kept with what it asked for. */
  function provenance(actor: FileActor): { conversationId?: string } {
    const conversationId = actor.recorded?.context.conversationId;
    return conversationId ? { conversationId } : {};
  }

  /** Lets what is kept by path follow, best effort: what fails stays where it was. */
  async function bestEffort(
    done: string,
    follow: (metadata: Pick<MetadataService, "onMoved" | "onDeleted">) => Promise<void>,
  ): Promise<{ warning?: string }> {
    if (deps.metadata === undefined) return {};
    try {
      await follow(deps.metadata);
      return {};
    } catch {
      return { warning: metadataWarning(done) };
    }
  }

  function done<T extends object>(
    value: T,
    history: FileOperationDone["history"],
    warning: { warning?: string } = {},
  ): T & FileOperationDone {
    return { ...value, ...warning, ...(history ? { history } : {}) };
  }

  return {
    async upload(actor, path, body, options) {
      const { action, from, ...storageOptions } = options;
      const subject = from ?? path;
      const before = actor.recorded ? await activityStat(actor.storage, subject) : undefined;
      const requested: ActivityFacts =
        from === undefined
          ? { path, kind: "file", ...provenance(actor) }
          : {
              path: from,
              targetPath: path,
              ...(action === "file.copy" ? { variant: "save_as" as const } : {}),
            };
      const staged = arrival(body);
      return gate(async (hold) => {
        const { value: entry, history } = await record(
          actor,
          { action, requested, ...(before ? { before } : {}) },
          () =>
            actor.storage.upload(path, staged.body, {
              ...storageOptions,
              // Only the publish holds the path, never the body as it arrives.
              // Once the body is all here, the publish takes the gate and
              // holds it until the upload is recorded.
              critical: async (work) => {
                if (staged.done) await hold();
                return deps.access.run(actor.identityId, { creates: [path] }, () => work());
              },
            }),
          (entry) => activityFacts(path, entry),
        );
        return done({ entry }, history);
      });
    },

    uploadPart(actor, path, body, options) {
      return actor.storage.uploadPart(path, body, options);
    },

    mkdir: (actor, path, options) =>
      gated(gate, async () => {
        const { value: entry, history } = await record(
          actor,
          { action: "folder.create", requested: { path, kind: "dir" } },
          () =>
            deps.access.run(actor.identityId, { creates: [path] }, () =>
              actor.storage.mkdir(path, options),
            ),
        );
        return done({ entry }, history);
      }),

    move: (actor, path, target, options = {}) =>
      gated(gate, async () => {
        const { identityId, storage } = actor;
        const action = options.action ?? "file.move";
        // Checked first, so a move that cannot happen leaves no new empty folder behind.
        const before = await activityStat(storage, path);
        const kind = before?.kind === "file" ? "file" : "dir";
        const { value: entry, history } = await record(
          actor,
          {
            action,
            requested: { path, targetPath: target, ...provenance(actor) },
            ...(before ? { before } : {}),
          },
          async () => {
            // Moving an item onto itself changes nothing; it is reported as it is.
            if (!relocates("move", path, target)) return storage.stat(path);
            return deps.access.run(
              identityId,
              { vacates: [path], creates: [target] },
              async (follow) => {
                await follow.moved(identityId, path, target, kind === "dir");
                // Created once the source was checked, so a move that cannot
                // happen leaves no new empty folder behind.
                if (options.createParents === true && before !== undefined)
                  await storage.mkdir(parentPath(target), { parents: true });
                return storage.move(path, target);
              },
            );
          },
          (entry) => ({ path: target, kind: entry.kind === "dir" ? "dir" : "file" }),
        );
        const warning =
          path === target
            ? {}
            : await bestEffort(action === "file.rename" ? "Renamed" : "Moved", (metadata) =>
                metadata.onMoved(identityId, path, target, kind === "dir"),
              );
        return done({ entry }, history, warning);
      }),

    copy: (actor, path, target, options = {}) =>
      gated(gate, async () => {
        const before = await activityStat(actor.storage, path);
        const { value: entry, history } = await record(
          actor,
          {
            action: "file.copy",
            requested: {
              path,
              targetPath: target,
              ...(options.variant ? { variant: options.variant } : {}),
            },
            ...(before ? { before } : {}),
          },
          async () => {
            if (!relocates("copy", path, target)) return actor.storage.stat(path);
            return deps.access.run(actor.identityId, { creates: [target] }, () =>
              actor.storage.copy(path, target),
            );
          },
          (entry) => ({
            path: target,
            kind: entry.kind === "dir" ? "dir" : "file",
            size: entry.size,
          }),
        );
        // A copy is a new item: nothing kept by path on the source comes along.
        return done({ entry }, history);
      }),

    trash: (actor, path) =>
      gated(gate, async () => {
        const { identityId, storage } = actor;
        const before = await activityStat(storage, path);
        const {
          value: { item, owned },
          history,
        } = await record(
          actor,
          {
            action: "file.trash",
            requested: {
              path,
              kind: before?.kind === "file" ? "file" : "dir",
              ...provenance(actor),
            },
            before: { path, kind: before?.kind === "file" ? "file" : "dir" },
          },
          async () => {
            const entry = await storage.stat(path);
            const kind = entry.kind === "dir" ? "dir" : "file";
            // The item goes to the Trash of the files that hold it: the login's
            // own, or for an item in a folder shared with it, its owner's.
            const owned = await deps.ownerPath(identityId, path);
            // Written first, so an interrupted delete is settled by what is on disk.
            const pending = await deps.trash.begin({
              identityId: owned.identityId,
              originalPath: owned.path,
              name: baseName(path),
              kind,
              size: kind === "file" ? entry.size : 0,
              deletedAt: clock(),
              movingFrom: owned.path,
            });
            const leaf = trashItemPath(pending.id, pending.name);
            try {
              const moved = await deps.access.run(
                identityId,
                { vacates: [path] },
                async (follow) => {
                  await follow.moved(owned.identityId, owned.path, leaf, kind === "dir");
                  if (!(await follow.trash.entered(pending.id, leaf)))
                    throw new StorageError("conflict", "the delete was given up");
                  return storage.trash.put(path, pending.id);
                },
              );
              return { item: moved, owned };
            } catch (error) {
              await settleQuietly(pending);
              throw error;
            }
          },
          ({ item: moved }) => ({ path, kind: moved.kind, trashLeaf: moved.leaf }),
        );
        const warning = await bestEffort("Moved to Trash", (metadata) =>
          followIntoTrash(metadata, async () => owned, identityId, path, item),
        );
        return done({ item }, history, warning);
      }),

    restore: (actor, id, target) =>
      gated(gate, async () => {
        const { identityId, storage } = actor;
        const item = await trashed(identityId, id);
        const leaf = trashItemPath(item.id, item.name);
        const destination = target ?? item.originalPath;
        const directory = item.kind === "dir";
        const { value: entry, history } = await record(
          actor,
          {
            action: "file.restore",
            requested: {
              path: item.originalPath,
              trashLeaf: leaf,
              ...(target ? { targetPath: target } : {}),
            },
          },
          () =>
            deps.access.run(
              identityId,
              { vacates: [leaf], creates: [destination] },
              async (follow) => {
                // A restore is a move out of Trash: what followed the item there comes back.
                await follow.moved(identityId, leaf, destination, directory);
                await follow.trash.left(item.id);
                return storage.trash.restore(item.id, item.name, destination);
              },
            ),
          (entry) => ({
            path: entry.path,
            kind: entry.kind === "dir" ? "dir" : "file",
            size: entry.size,
          }),
        );
        const warning = await bestEffort("Restored", (metadata) =>
          metadata.onMoved(identityId, leaf, entry.path, entry.kind === "dir"),
        );
        return done({ entry }, history, warning);
      }),

    purge: (actor, id, options = {}) =>
      gated(gate, async () => {
        const { identityId, storage } = actor;
        const item = await deps.trash.get(identityId, id);
        // Deleted for good already.
        if (item === null) return {};
        const leaf = trashItemPath(item.id, item.name);
        const directory = item.kind === "dir";
        const { history } = await record(
          actor,
          {
            action: "file.delete",
            requested: {
              path: item.originalPath,
              trashLeaf: leaf,
              ...(options.reason ? { reason: options.reason } : {}),
            },
          },
          () =>
            deps.access.run(identityId, { vacates: [leaf] }, async (follow) => {
              // What followed the item into Trash ends with it.
              await follow.removed(identityId, leaf, directory);
              await follow.trash.left(item.id);
              await storage.trash.purge(item.id);
            }),
        );
        const warning = await bestEffort("Deleted", (metadata) =>
          metadata.onDeleted(identityId, leaf, directory),
        );
        return done({}, history, warning);
      }),
  };

  /** Item `id` in `identityId`'s Trash; `not_found` when it is not there. */
  async function trashed(identityId: string, id: string) {
    const item = await deps.trash.get(identityId, id);
    if (item === null) throw new StorageError("not_found", `no such item in Trash: ${id}`);
    return item;
  }

  /**
   * Ends a delete that failed by what is on disk (`TrashItems.settle`): an
   * item that never moved stays where it was, and one that did arrives. If
   * even that fails, the next start settles it. Inside the delete's write,
   * so it holds no second gate.
   */
  async function settleQuietly(item: PendingTrashItem): Promise<void> {
    try {
      await deps.trash.settle(item);
    } catch (error) {
      deps.logger?.warn(
        { err: error, id: item.id, path: item.movingFrom },
        "a failed delete is settled at the next start",
      );
    }
  }
}

/**
 * Moves items in order, continuing past failures, never overwriting, and
 * reports each outcome. `POST /fs/move-many` and AI chat's move and rename
 * cards; a rename card passes `file.rename` so the activity reads as one.
 * With `createParents`, missing target folders are created once the source
 * was checked, so a move that cannot happen leaves no empty folder behind.
 */
export async function moveMany(
  files: FileOperations,
  principal: Principal,
  body: MoveManyRequest,
  context: ActivityCallContext,
  action: "file.move" | "file.rename" = "file.move",
  normalize: (path: string) => string = (path) => path,
): Promise<MoveManyResult[]> {
  const results: MoveManyResult[] = [];
  const batchId = context.batchId ?? randomUUID();
  const operationBase = context.producerOperationId ?? randomUUID();
  for (const item of body.items) {
    try {
      const path = normalize(item.path);
      const target = normalize(item.target);
      const moved = await files.move(
        fileActor(principal, {
          ...context,
          producerOperationId: `${operationBase}:${results.length}`,
          batchId,
        }),
        path,
        target,
        { action, ...(body.createParents === true ? { createParents: true } : {}) },
      );
      results.push({
        ok: true,
        path,
        target,
        ...(moved.warning ? { warning: moved.warning } : {}),
      });
    } catch (error) {
      const failure = failureOf(error);
      if (failure === null) throw error;
      results.push({ ok: false, path: item.path, target: item.target, error: failure });
    }
  }
  return results;
}

export interface TrashManyResult {
  readonly path: string;
  readonly ok: boolean;
  readonly error?: { kind: string; message: string };
}

/** Moves items to Trash one by one, continuing past failures. */
export async function trashMany(
  files: FileOperations,
  principal: Principal,
  items: readonly { path: string }[],
  context: ActivityCallContext,
  normalize: (path: string) => string = (path) => path,
): Promise<TrashManyResult[]> {
  const results: TrashManyResult[] = [];
  const batchId = context.batchId ?? randomUUID();
  const operationBase = context.producerOperationId ?? randomUUID();
  for (const item of items) {
    try {
      const path = normalize(item.path);
      await files.trash(
        fileActor(principal, {
          ...context,
          producerOperationId: `${operationBase}:${results.length}`,
          batchId,
        }),
        path,
      );
      results.push({ path, ok: true });
    } catch (error) {
      const failure = failureOf(error);
      if (failure === null) throw error;
      results.push({ path: item.path, ok: false, error: failure });
    }
  }
  return results;
}

/** An item's refusal as a batch reports it; `null` for anything that is not one. */
function failureOf(error: unknown): { kind: ApiHttpError["kind"]; message: string } | null {
  return error instanceof ApiHttpError || isStorageError(error)
    ? { kind: error.kind, message: error.message }
    : null;
}
