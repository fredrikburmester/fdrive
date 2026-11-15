import { randomUUID } from "node:crypto";
import type {
  ActivityFacts,
  PersonalActivityAction,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { parseMoveTrashLeaf, type StorageProvider, TRASH_PATH, trashLeafPath } from "@fdrive/core";
import type { Principal } from "../auth/principal.js";
import { activityStat, type PersonalActivityService } from "./service.js";

export interface ActivityStorageContext {
  source: PersonalActivitySource;
  operationId?: string;
  uploadAction?: "file.upload" | "file.create" | "file.save";
  copyVariant?: "save_as" | "duplicate";
}
/** Decorate only explicit command execution. Automatic lists, stats and probes stay silent. */
export function activityStorage(
  principal: Principal,
  service: PersonalActivityService,
  context: () => ActivityStorageContext,
): StorageProvider {
  const storage = principal.storage;
  async function run<T>(
    action: PersonalActivityAction,
    requested: ActivityFacts,
    mutate: () => Promise<T>,
    facts?: (value: T) => ActivityFacts | Promise<ActivityFacts>,
  ) {
    const ctx = context();
    const before = requested.path ? await activityStat(storage, requested.path) : undefined;
    const result = await service.run(
      principal,
      {
        action,
        source: ctx.source,
        producerOperationId: ctx.operationId ?? randomUUID(),
        requested,
        ...(before ? { before } : {}),
      },
      mutate,
      facts,
    );
    return result.value;
  }
  const overrides: { -readonly [K in keyof StorageProvider]?: StorageProvider[K] } = {
    async upload(path, body, options) {
      const size = body instanceof Uint8Array ? body.byteLength : options?.contentLength;
      await run(
        context().uploadAction ?? "file.create",
        { path, kind: "file" },
        () => storage.upload(path, body, options),
        async () =>
          (await activityStat(storage, path)) ?? {
            path,
            kind: "file",
            ...(size === undefined ? {} : { size }),
            ...(options?.modifiedAt ? { modifiedAt: options.modifiedAt.toISOString() } : {}),
          },
      );
    },
    async mkdir(path, options) {
      return run("folder.create", { path, kind: "dir" }, () => storage.mkdir(path, options));
    },
    async move(from, to, options) {
      return run(
        "file.move",
        { path: from, targetPath: to },
        () => storage.move(from, to, options),
        () => ({ path: to }),
      );
    },
    async copy(from, to, options) {
      return run(
        "file.copy",
        {
          path: from,
          targetPath: to,
          ...(context().copyVariant ? { variant: context().copyVariant } : {}),
        },
        () => storage.copy(from, to, options),
        () => ({ path: to }),
      );
    },
    async deleteFile(path) {
      return run("file.delete", { path, kind: "file" }, () => storage.deleteFile(path));
    },
    async deleteDir(path) {
      return run("file.delete", { path, kind: "dir" }, () => storage.deleteDir(path));
    },
  };
  const trash = storage.trash;
  overrides.trash = {
    ...trash,
    // Moves of the same path wait for each other, so two cannot claim one new leaf.
    async put(path) {
      return service.repo.withPathLock(principal.identityId, path, () =>
        run(
          "file.trash",
          { path },
          () => trash.put(path),
          (moved) => ({ path, kind: moved.kind, trashLeaf: moved.leaf }),
        ),
      );
    },
    async restore(id, options) {
      const leaf = trashLeafPath(TRASH_PATH, id);
      const original = parseMoveTrashLeaf(TRASH_PATH, leaf)?.originalPath;
      return run(
        "file.restore",
        {
          ...(original ? { path: original } : {}),
          trashLeaf: leaf,
          ...(options?.target ? { targetPath: options.target } : {}),
        },
        () => trash.restore(id, options),
        (entry) => ({ path: entry.path, kind: entry.kind === "dir" ? "dir" : "file" }),
      );
    },
  };
  return new Proxy(storage, {
    get(target, key, receiver) {
      const override = Reflect.get(overrides, key);
      if (override !== undefined) return override;
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
