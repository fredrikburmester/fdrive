import { randomUUID } from "node:crypto";

export type ShareScope = "read" | "write";
/** Operator-chosen public page rendering. Mirrors `@fdrive/contracts` `SharePresentation`. */
export type SharePresentation = "auto" | "list" | "gallery" | "download";
/**
 * One row of `app.shares`, a link fdrive serves itself. The password hash a
 * row may hold is never part of the record: see `ShareRepo.passwordHash`.
 */
export interface ShareRecord {
  readonly id: string;
  readonly identityId: string;
  readonly name: string;
  readonly description: string;
  readonly scope: ShareScope;
  readonly paths: readonly string[];
  readonly hasPassword: boolean;
  readonly expiresAt: Date | null;
  readonly maxDownloads: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Legacy column name: the downloads (or uploads) counted so far (see `consume`). */
  readonly views: number;
  readonly presentation: SharePresentation;
}
/**
 * A new owned row. `passwordHash` is stored beside the row and sets
 * `hasPassword`; `null` for an open share.
 */
export interface ShareInsertInput
  extends Omit<ShareRecord, "id" | "createdAt" | "updatedAt" | "views" | "hasPassword"> {
  readonly passwordHash: string | null;
  readonly at: Date;
}
/**
 * A full replacement of an owned row's editable fields, applied at `at`.
 * `passwordHash` omitted keeps the stored password, `null` removes it and
 * a hash replaces it; `hasPassword` follows.
 */
export interface ShareOwnedUpdate extends Omit<ShareInsertInput, "identityId" | "passwordHash"> {
  readonly passwordHash?: string | null;
}
export interface ShareListOptions {
  readonly limit?: number;
}
export interface ShareRepo {
  /** Writes a new owned row. */
  insert(input: ShareInsertInput): Promise<ShareRecord>;
  /** Replaces an owned row's editable fields; `null` for a missing or foreign row. */
  updateOwned(identityId: string, id: string, input: ShareOwnedUpdate): Promise<ShareRecord | null>;
  /** Internal public-proxy lookup only. Does not authorize access. */
  get(id: string): Promise<ShareRecord | null>;
  getOwned(identityId: string, id: string): Promise<ShareRecord | null>;
  listOwned(identityId: string, options?: ShareListOptions): Promise<ShareRecord[]>;
  /** Removes the row; `false` for a missing or foreign one. */
  removeOwned(identityId: string, id: string): Promise<boolean>;
  /**
   * Follows a move in the owner's files: in every share of `identityId`, the
   * path `from` and (when `isDir`) every path inside it take their place
   * under `to`, wherever that is; `/a` never matches `/ab`. What a link may
   * serve there is the public routes' to decide. Leaves `updatedAt` alone,
   * since the owner changed nothing. See `apps/api/src/shares/moves.ts`.
   */
  movePrefix(identityId: string, from: string, to: string, isDir: boolean): Promise<void>;
  /**
   * Follows a delete in the owner's files: every share of `identityId` drops
   * `path` and (when `isDir`) every path inside it, and a share left with no
   * path is removed, so no link is left where a new item could appear.
   */
  deletePrefix(identityId: string, path: string, isDir: boolean): Promise<void>;
  /**
   * The stored password hash of an owned share, for the credential check
   * only; `null` for an open share or a missing one.
   */
  passwordHash(id: string): Promise<string | null>;
  /**
   * Spends one download of an owned share, after the download succeeded:
   * one more `views` only while the limit and the expiry still allow it.
   * `null` when the row is missing, expired or exhausted, so a
   * caller that got `null` has been refused, never counted.
   */
  consume(id: string, now: Date): Promise<ShareRecord | null>;
}
export interface MemoryShareOptions {
  readonly id?: () => string;
}

export function validateShareId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new TypeError("Expected canonical UUID");
}
export function parseShareScope(scope: string): ShareScope {
  if (scope !== "read" && scope !== "write") throw new TypeError("Invalid share scope");
  return scope;
}
export function parseSharePresentation(presentation: string): SharePresentation {
  if (
    presentation !== "auto" &&
    presentation !== "list" &&
    presentation !== "gallery" &&
    presentation !== "download"
  )
    throw new TypeError("Invalid share presentation");
  return presentation;
}
export function validateSharePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    !path.startsWith("/") ||
    /[\\\p{Cc}]/u.test(path)
  )
    throw new TypeError("Invalid canonical virtual path");
  if (path === "/") return;
  if (
    path
      .slice(1)
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new TypeError("Invalid canonical virtual path");
}
function validateDate(date: Date): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new TypeError("Invalid share timestamp");
}
/** The fields every row carries. */
function validateShareFields(
  input: Pick<
    ShareRecord,
    "name" | "description" | "scope" | "paths" | "expiresAt" | "maxDownloads" | "presentation"
  >,
): void {
  if (
    typeof input.name !== "string" ||
    input.name.length < 1 ||
    input.name.length > 255 ||
    /\p{Cc}/u.test(input.name)
  )
    throw new TypeError("Invalid share name");
  // A description may span lines.
  if (typeof input.description !== "string" || input.description.length > 65536)
    throw new TypeError("Invalid share description");
  parseShareScope(input.scope);
  if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 1000)
    throw new TypeError("A share requires 1 to 1000 paths");
  for (const path of input.paths) validateSharePath(path);
  parseSharePresentation(input.presentation);
  if (
    !Number.isInteger(input.maxDownloads) ||
    input.maxDownloads < 0 ||
    input.maxDownloads > 2_147_483_647
  )
    throw new TypeError("Invalid share download limit");
  if (input.expiresAt !== null) validateDate(input.expiresAt);
}
function validatePasswordHash(hash: string | null): void {
  if (hash === null) return;
  if (typeof hash !== "string" || hash.length < 1 || hash.length > 1024 || /\p{Cc}/u.test(hash))
    throw new TypeError("Invalid share password hash");
}
export function validateShareInsert(input: ShareInsertInput): void {
  validateShareId(input.identityId);
  validateShareFields(input);
  validatePasswordHash(input.passwordHash);
  validateDate(input.at);
}
export function validateShareOwnedUpdate(
  identityId: string,
  id: string,
  input: ShareOwnedUpdate,
): void {
  validateShareOwnership(identityId, id);
  validateShareFields(input);
  if (input.passwordHash !== undefined) validatePasswordHash(input.passwordHash);
  validateDate(input.at);
}
export function shareListLimit(options: ShareListOptions = {}): number {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new TypeError("Share limit must be between 1 and 1000");
  return limit;
}
export function validateShareOwnership(identityId: string, id: string): void {
  validateShareId(identityId);
  validateShareId(id);
}
/** The fields an owned update replaces, copied so a caller's later mutation cannot reach the row. */
export function shareEditableValues(
  input: Pick<
    ShareRecord,
    "name" | "description" | "scope" | "paths" | "expiresAt" | "maxDownloads" | "presentation"
  >,
) {
  return {
    name: input.name,
    description: input.description,
    scope: input.scope,
    paths: [...input.paths],
    expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
    maxDownloads: input.maxDownloads,
    presentation: input.presentation,
  };
}
export function cloneShareRecord(record: ShareRecord): ShareRecord {
  return {
    ...record,
    paths: [...record.paths],
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt),
  };
}
export function compareShareRecords(a: ShareRecord, b: ShareRecord): number {
  const time = b.createdAt.getTime() - a.createdAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** Checks paths `movePrefix` or `deletePrefix` follows: canonical, and never the root itself. */
export function validateSharePathChange(identityId: string, ...paths: string[]): void {
  validateShareId(identityId);
  for (const path of paths) {
    validateSharePath(path);
    if (path === "/") throw new TypeError("The root cannot move or go");
  }
}
/**
 * `paths` once `from` moved to `to`, in order. A path the move lands on a
 * second time (an overwriting move onto another shared path) is kept once,
 * where it first stood.
 */
export function movedSharePaths(
  paths: readonly string[],
  from: string,
  to: string,
  isDir: boolean,
): string[] {
  const prefix = `${from}/`;
  const moved = paths.map((path) =>
    path === from
      ? to
      : isDir && path.startsWith(prefix)
        ? `${to}/${path.slice(prefix.length)}`
        : path,
  );
  return [...new Set(moved)];
}
/** Whether `path` is `changed`, or (when `isDir`) inside it. */
export function sharePathChanged(path: string, changed: string, isDir: boolean): boolean {
  return path === changed || (isDir && path.startsWith(`${changed}/`));
}

/** Whether `record` still admits one more download at `now`; the check `consume` makes. */
export function shareAdmitsDownload(
  record: Pick<ShareRecord, "expiresAt" | "maxDownloads" | "views">,
  now: Date,
): boolean {
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) return false;
  return record.maxDownloads === 0 || record.views < record.maxDownloads;
}

/** Test adapter. Writes mutate synchronously, so concurrent promises retain one UUID. */
export function createMemoryShareRepo(options: MemoryShareOptions = {}): ShareRepo {
  const rows = new Map<string, ShareRecord>();
  const hashes = new Map<string, string>();
  const nextId = options.id ?? randomUUID;
  return {
    async insert(input) {
      validateShareInsert(input);
      const record: ShareRecord = {
        ...shareEditableValues(input),
        id: nextId(),
        identityId: input.identityId,
        hasPassword: input.passwordHash !== null,
        views: 0,
        createdAt: new Date(input.at),
        updatedAt: new Date(input.at),
      };
      rows.set(record.id, record);
      if (input.passwordHash !== null) hashes.set(record.id, input.passwordHash);
      return cloneShareRecord(record);
    },
    async updateOwned(identityId, id, input) {
      validateShareOwnedUpdate(identityId, id, input);
      const current = rows.get(id);
      if (current === undefined || current.identityId !== identityId) return null;
      if (input.passwordHash === null) hashes.delete(id);
      else if (input.passwordHash !== undefined) hashes.set(id, input.passwordHash);
      const record: ShareRecord = {
        ...current,
        ...shareEditableValues(input),
        hasPassword: hashes.has(id),
        updatedAt: new Date(input.at),
      };
      rows.set(id, record);
      return cloneShareRecord(record);
    },
    async get(id) {
      validateShareId(id);
      const row = rows.get(id);
      return row ? cloneShareRecord(row) : null;
    },
    async getOwned(identityId, id) {
      validateShareOwnership(identityId, id);
      const row = rows.get(id);
      return row?.identityId === identityId ? cloneShareRecord(row) : null;
    },
    async listOwned(identityId, options) {
      validateShareId(identityId);
      const limit = shareListLimit(options);
      return [...rows.values()]
        .filter((row) => row.identityId === identityId)
        .sort(compareShareRecords)
        .slice(0, limit)
        .map(cloneShareRecord);
    },
    async removeOwned(identityId, id) {
      validateShareOwnership(identityId, id);
      if (rows.get(id)?.identityId !== identityId) return false;
      hashes.delete(id);
      return rows.delete(id);
    },
    async movePrefix(identityId, from, to, isDir) {
      validateSharePathChange(identityId, from, to);
      if (from === to) return;
      for (const [id, row] of rows) {
        if (row.identityId !== identityId) continue;
        if (!row.paths.some((path) => sharePathChanged(path, from, isDir))) continue;
        rows.set(id, { ...row, paths: movedSharePaths(row.paths, from, to, isDir) });
      }
    },
    async deletePrefix(identityId, path, isDir) {
      validateSharePathChange(identityId, path);
      for (const [id, row] of rows) {
        if (row.identityId !== identityId) continue;
        const kept = row.paths.filter((shared) => !sharePathChanged(shared, path, isDir));
        if (kept.length === row.paths.length) continue;
        if (kept.length > 0) rows.set(id, { ...row, paths: kept });
        else {
          rows.delete(id);
          hashes.delete(id);
        }
      }
    },
    async passwordHash(id) {
      validateShareId(id);
      return hashes.get(id) ?? null;
    },
    async consume(id, now) {
      validateShareId(id);
      validateDate(now);
      const current = rows.get(id);
      if (current === undefined) return null;
      if (!shareAdmitsDownload(current, now)) return null;
      const record = { ...current, views: current.views + 1 };
      rows.set(id, record);
      return cloneShareRecord(record);
    },
  };
}
