import { randomUUID } from "node:crypto";
import type { ActivityFacts, MoveManyRequest, MoveManyResult } from "@fdrive/contracts";
import {
  isStorageError,
  isUnderPath,
  parentPath,
  parseMoveTrashLeaf,
  StorageError,
  type StorageProvider,
  TRASH_PATH,
  type TrashedItem,
  type TrashRestoreResult,
  trashLeafPath,
} from "@fdrive/core";
import type { ActivityCallContext } from "../activity/fs-context.ts";
import {
  type ActivityRunInput,
  activityStat,
  type PersonalActivityService,
} from "../activity/service.ts";
import type { Principal } from "../auth/principal.ts";
import { ApiHttpError } from "../errors.ts";
import type { MetadataService } from "../metadata/service.ts";
import { followIntoTrash } from "../metadata/trash.ts";
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
type UploadOptions = NonNullable<Parameters<StorageProvider["upload"]>[2]>;

export interface FileUploadOptions extends UploadOptions {
  readonly action: "file.upload" | "file.create" | "file.save" | "file.copy";
  /**
   * The document an editor saved from, when it is not `path`: Office's Save
   * As, recorded as a copy of it.
   */
  readonly from?: string;
}

export interface FileOperations {
  upload(
    actor: FileActor,
    path: string,
    body: UploadBody,
    options: FileUploadOptions,
  ): Promise<FileOperationDone>;
  mkdir(
    actor: FileActor,
    path: string,
    options?: { parents?: boolean },
  ): Promise<FileOperationDone>;
  move(
    actor: FileActor,
    path: string,
    target: string,
    options?: { action?: "file.move" | "file.rename"; createParents?: boolean },
  ): Promise<FileOperationDone & { kind: "file" | "dir" }>;
  copy(
    actor: FileActor,
    path: string,
    target: string,
    options?: { variant?: "duplicate" },
  ): Promise<FileOperationDone & { kind: "file" | "dir" }>;
  trash(actor: FileActor, path: string): Promise<FileOperationDone & { item: TrashedItem }>;
  restore(
    actor: FileActor,
    id: string,
    target?: string,
  ): Promise<FileOperationDone & { entry: TrashRestoreResult }>;
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
  /** A login's own storage, which takes an item back out of its Trash. */
  readonly storageFor: (identityId: string) => Promise<StorageProvider>;
  readonly logger?: { error(object: Record<string, unknown>, message: string): void };
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

/** The leaf's id, its path below the Trash. */
function trashId(leaf: string): string {
  return leaf.slice(TRASH_PATH.length + 1);
}

/**
 * The one way fdrive changes files, whoever asks: the web's file and Trash
 * routes, MCP, AI chat, Office and a link's visitors. Each operation records
 * its intent, then runs its storage call in one transaction with what grants
 * access (`AccessFollowers.run`), records the outcome and lets the rest of
 * what is kept by path follow.
 *
 * What grants access fails closed: it changes before the storage call where
 * the destination is known (a move, a restore, a purge), so a failure there
 * leaves the file where it was and the request fails. Trash names its leaf
 * only once the item is there, so a failure after it takes the item back out
 * of Trash. Either way, no link, share with people or Office file stays at a
 * path a successful operation left, and a new item there waits for them to
 * have gone (`TouchedPaths`).
 */
export function createFileOperations(deps: FileOperationsDeps): FileOperations {
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

  /** Creates the target's missing parent folders, once the source was checked. */
  async function ensureParent(storage: StorageProvider, target: string): Promise<void> {
    const parent = parentPath(target);
    if (parent === "/") return;
    try {
      await storage.stat(parent);
      return;
    } catch (error) {
      if (!isStorageError(error) || error.kind !== "not_found") throw error;
    }
    await storage.mkdir(parent, { parents: true });
  }

  return {
    async upload(actor, path, body, options) {
      const { action, from, ...storageOptions } = options;
      // A piece before the last only grows the upload's part; the last one
      // publishes the file as one upload.
      if (storageOptions.part?.final === false) {
        await actor.storage.upload(path, body, storageOptions);
        return {};
      }
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
      const { history } = await record(
        actor,
        { action, requested, ...(before ? { before } : {}) },
        () =>
          deps.access.run(actor.identityId, { creates: [path] }, () =>
            actor.storage.upload(path, body, storageOptions),
          ),
        async () =>
          (await activityStat(actor.storage, path)) ?? {
            path,
            kind: "file",
            ...(storageOptions.contentLength === undefined
              ? {}
              : { size: storageOptions.contentLength }),
            ...(storageOptions.modifiedAt
              ? { modifiedAt: storageOptions.modifiedAt.toISOString() }
              : {}),
          },
      );
      return done({}, history);
    },

    async mkdir(actor, path, options) {
      const { history } = await record(
        actor,
        { action: "folder.create", requested: { path, kind: "dir" } },
        () =>
          deps.access.run(actor.identityId, { creates: [path] }, () =>
            actor.storage.mkdir(path, options),
          ),
      );
      return done({}, history);
    },

    async move(actor, path, target, options = {}) {
      const { identityId, storage } = actor;
      const action = options.action ?? "file.move";
      // Checked first, so a move that cannot happen leaves no new empty folder behind.
      const before = await activityStat(storage, path);
      const kind = before?.kind === "file" ? "file" : "dir";
      const { history } = await record(
        actor,
        {
          action,
          requested: { path, targetPath: target, ...provenance(actor) },
          ...(before ? { before } : {}),
        },
        async () => {
          if (!relocates("move", path, target)) return;
          await deps.access.run(
            identityId,
            { vacates: [path], creates: [target] },
            async (follow) => {
              await follow.moved(identityId, path, target, kind === "dir");
              if (options.createParents === true && before !== undefined)
                await ensureParent(storage, target);
              await storage.move(path, target);
            },
          );
        },
        () => ({ path: target, ...(before?.kind ? { kind: before.kind } : {}) }),
      );
      const warning =
        path === target
          ? {}
          : await bestEffort(action === "file.rename" ? "Renamed" : "Moved", (metadata) =>
              metadata.onMoved(identityId, path, target, kind === "dir"),
            );
      return done({ kind }, history, warning);
    },

    async copy(actor, path, target, options = {}) {
      const before = await activityStat(actor.storage, path);
      const { history } = await record(
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
          if (!relocates("copy", path, target)) return;
          await deps.access.run(actor.identityId, { creates: [target] }, () =>
            actor.storage.copy(path, target),
          );
        },
        () => ({
          path: target,
          ...(before?.kind ? { kind: before.kind } : {}),
          ...(before?.size === undefined ? {} : { size: before.size }),
        }),
      );
      // A copy is a new item: nothing kept by path on the source comes along.
      return done({ kind: before?.kind === "file" ? "file" : "dir" }, history);
    },

    async trash(actor, path) {
      const { identityId, storage } = actor;
      const before = await activityStat(storage, path);
      const kind = before?.kind === "file" ? "file" : "dir";
      const {
        value: { item, owned },
        history,
      } = await record(
        actor,
        {
          action: "file.trash",
          requested: { path, kind, ...provenance(actor) },
          before: { path, kind },
        },
        () =>
          deps.access.run(identityId, { vacates: [path] }, async (follow) => {
            const moved = await storage.trash.put(path);
            // The leaf is in the files that hold the item: the login's own, or
            // for an item in a folder shared with it, its owner's.
            const owner = await deps.ownerPath(identityId, path);
            try {
              await follow.moved(owner.identityId, owner.path, moved.leaf, moved.kind === "dir");
            } catch (error) {
              await takeBack(owner.identityId, path, moved, error);
              throw error;
            }
            return { item: moved, owned: owner };
          }),
        ({ item: moved }) => ({ path, kind: moved.kind, trashLeaf: moved.leaf }),
      );
      const warning = await bestEffort("Moved to Trash", (metadata) =>
        followIntoTrash(metadata, async () => owned, identityId, path, item),
      );
      return done({ item }, history, warning);
    },

    async restore(actor, id, target) {
      const { identityId, storage } = actor;
      const leaf = trashLeafPath(TRASH_PATH, id);
      const parsed = parseMoveTrashLeaf(TRASH_PATH, leaf);
      const original = parsed?.originalPath ?? leaf;
      const destination = target ?? original;
      const directory = parsed?.kind !== "file";
      const { value: entry, history } = await record(
        actor,
        {
          action: "file.restore",
          requested: { path: original, trashLeaf: leaf, ...(target ? { targetPath: target } : {}) },
        },
        () =>
          deps.access.run(
            identityId,
            { vacates: [leaf], creates: [destination] },
            async (follow) => {
              // A restore is a move out of Trash: what followed the item there comes back.
              await follow.moved(identityId, leaf, destination, directory);
              return storage.trash.restore(id, target === undefined ? undefined : { target });
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
    },

    async purge(actor, id, options = {}) {
      const { identityId, storage } = actor;
      const leaf = trashLeafPath(TRASH_PATH, id);
      const parsed = parseMoveTrashLeaf(TRASH_PATH, leaf);
      const directory = parsed?.kind !== "file";
      const { history } = await record(
        actor,
        {
          action: "file.delete",
          requested: {
            path: parsed?.originalPath ?? leaf,
            trashLeaf: leaf,
            ...(options.reason ? { reason: options.reason } : {}),
          },
        },
        () =>
          deps.access.run(identityId, { vacates: [leaf] }, async (follow) => {
            // What followed the item into Trash ends with it.
            await follow.removed(identityId, leaf, directory);
            await storage.trash.purge(id);
          }),
      );
      const warning = await bestEffort("Deleted", (metadata) =>
        metadata.onDeleted(identityId, leaf, directory),
      );
      return done({}, history, warning);
    },
  };

  /**
   * Takes an item back out of Trash when what grants access could not follow
   * it there, so nothing stays at the path it left. Its owner's Trash holds
   * it. The path is still held, so nothing new can have taken it.
   */
  async function takeBack(
    owner: string,
    path: string,
    moved: TrashedItem,
    cause: unknown,
  ): Promise<void> {
    try {
      await (await deps.storageFor(owner)).trash.restore(trashId(moved.leaf));
    } catch (error) {
      deps.logger?.error(
        { err: error, cause, path, leaf: moved.leaf },
        "an item stays in Trash although what grants access to its old path could not follow it",
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
