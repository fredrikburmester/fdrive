import { randomUUID } from "node:crypto";

export type ShareScope = "read" | "write";
/** Operator-chosen public page rendering. Mirrors `@fdrive/contracts` `SharePresentation`. */
export type SharePresentation = "auto" | "list" | "gallery" | "download";
/**
 * One row of `app.shares`. A native row mirrors a share the backend keeps
 * (`sftpgoShareId` names it there); an owned row is one fdrive serves
 * itself and has no upstream id. The password hash an owned row may hold is
 * never part of the record: see `ShareRepo.passwordHash`.
 */
export interface ShareRecord {
  readonly id: string;
  readonly identityId: string;
  readonly sftpgoShareId: string | null;
  readonly name: string;
  readonly description: string;
  readonly scope: ShareScope;
  readonly paths: readonly string[];
  readonly hasPassword: boolean;
  readonly expiresAt: Date | null;
  readonly maxDownloads: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * Legacy column name. A native row caches the backend's used transfer
   * tokens; an owned row counts its own downloads here (see `consume`).
   */
  readonly views: number;
  readonly presentation: SharePresentation;
}
/** A native row, mirrored from the backend's share. `at` is the creation time on first insert only. */
export interface ShareUpsertInput extends Omit<ShareRecord, "id" | "createdAt" | "sftpgoShareId"> {
  readonly sftpgoShareId: string;
  readonly at: Date;
}
/**
 * A new owned row. `passwordHash` is stored beside the row and sets
 * `hasPassword`; `null` for an open share.
 */
export interface ShareInsertInput
  extends Omit<
    ShareRecord,
    "id" | "createdAt" | "updatedAt" | "views" | "sftpgoShareId" | "hasPassword"
  > {
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
  /** Writes a native row, keyed by the backend's share id per identity. */
  upsert(input: ShareUpsertInput): Promise<ShareRecord>;
  /** Writes a new owned row. */
  insert(input: ShareInsertInput): Promise<ShareRecord>;
  /** Replaces an owned row's editable fields; `null` for a missing, foreign or native row. */
  updateOwned(identityId: string, id: string, input: ShareOwnedUpdate): Promise<ShareRecord | null>;
  /** Internal public-proxy lookup only. Does not authorize access. */
  get(id: string): Promise<ShareRecord | null>;
  getOwned(identityId: string, id: string): Promise<ShareRecord | null>;
  listOwned(identityId: string, options?: ShareListOptions): Promise<ShareRecord[]>;
  /** Removes local metadata only, after upstream deletion succeeds. */
  removeOwned(identityId: string, id: string): Promise<boolean>;
  /**
   * The stored password hash of an owned share, for the credential check
   * only; `null` for an open share, a native row or a missing one.
   */
  passwordHash(id: string): Promise<string | null>;
  /**
   * Spends one download of an owned share, after the download succeeded:
   * one more `views` only while the limit and the expiry still allow it.
   * `null` when the row is missing, native, expired or exhausted, so a
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
/** The fields every kind of row carries, checked the same way for both. */
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
  // A description may span lines; the backend's own limit governs a native row.
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
export function validateShareUpsert(input: ShareUpsertInput): void {
  validateShareId(input.identityId);
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(input.sftpgoShareId))
    throw new TypeError("Invalid upstream share identifier");
  validateShareFields(input);
  if (typeof input.hasPassword !== "boolean") throw new TypeError("Invalid password flag");
  if (!Number.isInteger(input.views) || input.views < 0 || input.views > 2_147_483_647)
    throw new TypeError("Invalid cached share views");
  validateDate(input.at);
  validateDate(input.updatedAt);
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
/** Select only metadata fields, including when callers supply extra runtime properties. */
export function shareStoredValues(input: ShareUpsertInput) {
  return {
    identityId: input.identityId,
    sftpgoShareId: input.sftpgoShareId,
    ...shareEditableValues(input),
    hasPassword: input.hasPassword,
    views: input.views,
    updatedAt: new Date(input.updatedAt),
  };
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
    async upsert(input) {
      validateShareUpsert(input);
      const existing = [...rows.values()].find(
        (row) => row.identityId === input.identityId && row.sftpgoShareId === input.sftpgoShareId,
      );
      const record: ShareRecord = {
        ...shareStoredValues(input),
        id: existing?.id ?? nextId(),
        createdAt: existing?.createdAt ?? new Date(input.at),
      };
      rows.set(record.id, record);
      return cloneShareRecord(record);
    },
    async insert(input) {
      validateShareInsert(input);
      const record: ShareRecord = {
        ...shareEditableValues(input),
        id: nextId(),
        identityId: input.identityId,
        sftpgoShareId: null,
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
      if (current.sftpgoShareId !== null) return null;
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
    async passwordHash(id) {
      validateShareId(id);
      return hashes.get(id) ?? null;
    },
    async consume(id, now) {
      validateShareId(id);
      validateDate(now);
      const current = rows.get(id);
      if (current === undefined || current.sftpgoShareId !== null) return null;
      if (!shareAdmitsDownload(current, now)) return null;
      const record = { ...current, views: current.views + 1 };
      rows.set(id, record);
      return cloneShareRecord(record);
    },
  };
}
