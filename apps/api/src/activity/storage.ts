import { randomUUID } from "node:crypto";
import type {
  ActivityFacts,
  PersonalActivityAction,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { type StorageProvider, trashLeafPath } from "@fdrive/core";
import type { Principal } from "../auth/principal.js";
import { activityStat, type PersonalActivityService } from "./service.js";
import { activityTrashLeaf, deleteWithActivityReceipt } from "./trash.js";

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
  trashRoot: string | null = null,
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
      if (!trashRoot)
        return run("file.delete", { path, kind: "file" }, () => storage.deleteFile(path));
      await service.repo.withPathLock(principal.identityId, path, () =>
        run(
          "file.trash",
          { path, kind: "file" },
          () => deleteWithActivityReceipt(storage, path, "file", trashRoot),
          (facts) => facts,
        ),
      );
    },
    async deleteDir(path) {
      if (!trashRoot)
        return run("file.delete", { path, kind: "dir" }, () => storage.deleteDir(path));
      await service.repo.withPathLock(principal.identityId, path, () =>
        run(
          "file.trash",
          { path, kind: "dir" },
          () => deleteWithActivityReceipt(storage, path, "dir", trashRoot),
          (facts) => facts,
        ),
      );
    },
  };
  if (storage.trash && trashRoot) {
    const trash = storage.trash;
    overrides.trash = {
      ...trash,
      async restore(id, options) {
        const leaf = trashLeafPath(trashRoot, id);
        const original = activityTrashLeaf(trashRoot, leaf)?.originalPath;
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
  }
  return new Proxy(storage, {
    get(target, key, receiver) {
      const override = Reflect.get(overrides, key);
      if (override !== undefined) return override;
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
