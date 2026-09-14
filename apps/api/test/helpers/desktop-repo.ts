import { randomUUID } from "node:crypto";
import type { DesktopItemRecord, DesktopOperationRecord, DesktopRepo } from "@fdrive/db";

export function memoryRepo() {
  const items = new Map<string, DesktopItemRecord>();
  const operations = new Map<string, DesktopOperationRecord>();
  const repo: DesktopRepo = {
    async ensure(identityId, path, kind) {
      const item = await repo.at(identityId, path);
      if (item?.kind === kind) return item;
      if (item) await repo.remove(identityId, path);
      const result: DesktopItemRecord = {
        id: randomUUID(),
        identityId,
        path,
        kind,
        metadataVersion: randomUUID(),
        contentVersion: null,
        originalPath: null,
        deletedAt: null,
      };
      items.set(result.id, result);
      return result;
    },
    async item(identityId, id) {
      const value = items.get(id);
      return value?.identityId === identityId && !value.deletedAt ? { ...value } : null;
    },
    async at(identityId, path) {
      return (
        [...items.values()].find(
          (item) => item.identityId === identityId && item.path === path && !item.deletedAt,
        ) ?? null
      );
    },
    async children(identityId, path) {
      return [...items.values()].filter(
        (item) =>
          item.identityId === identityId &&
          item.path.slice(0, item.path.lastIndexOf("/")) === (path === "/" ? "" : path) &&
          !item.deletedAt,
      );
    },
    async update(identityId, id, values) {
      const old = await repo.item(identityId, id);
      if (!old) throw Error("missing");
      const item = { ...old, ...values, metadataVersion: randomUUID() };
      items.set(id, item);
      return item;
    },
    async move(identityId, from, to) {
      if (from === to) return;
      for (const [id, item] of items)
        if (
          item.identityId === identityId &&
          !item.deletedAt &&
          (item.path === from || item.path.startsWith(from + "/"))
        )
          items.set(id, {
            ...item,
            path: to + item.path.slice(from.length),
            metadataVersion: randomUUID(),
          });
    },
    async remove(identityId, path) {
      for (const [id, item] of items)
        if (
          item.identityId === identityId &&
          (item.path === path || item.path.startsWith(path + "/"))
        )
          items.set(id, { ...item, deletedAt: new Date() });
    },
    async reserve(input) {
      const key = input.identityId + input.id;
      const old = operations.get(key);
      if (old) return old;
      const value = { ...input, result: null, createdAt: new Date(), updatedAt: new Date() };
      operations.set(key, value);
      return value;
    },
    async operation(identityId, accountId, id) {
      const value = operations.get(identityId + id);
      return value?.accountId === accountId ? { ...value } : null;
    },
    async transition(identityId, accountId, id, expected, state, result, attempt) {
      // Model PostgreSQL's atomic compare-and-swap without yielding between read/write.
      const old = operations.get(identityId + id);
      if (
        !old ||
        old.accountId !== accountId ||
        old.state !== expected ||
        (attempt !== undefined && old.result?.attempt !== attempt)
      )
        return false;
      operations.set(identityId + id, {
        ...old,
        state,
        result: result ?? old.result,
        updatedAt: new Date(),
      });
      return true;
    },
    async captureEffects(_identityId, _accountId, context) {
      return { ...context, snapshots: [] };
    },
    async complete(identityId, accountId, id, result) {
      return repo.transition(identityId, accountId, id, "committing", "completed", result);
    },
  };
  return { repo, items, operations };
}
