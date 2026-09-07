import { randomUUID } from "node:crypto";

export type ShareScope = "read" | "write";
export interface ShareRecord {
  readonly id: string;
  readonly identityId: string;
  readonly sftpgoShareId: string;
  readonly name: string;
  readonly scope: ShareScope;
  readonly paths: readonly string[];
  readonly hasPassword: boolean;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly views: number;
}
export interface ShareUpsertInput extends Omit<ShareRecord, "id" | "createdAt"> {
  readonly at: Date;
}
export interface ShareListOptions {
  readonly limit?: number;
}
export interface ShareRepo {
  upsert(input: ShareUpsertInput): Promise<ShareRecord>;
  /** Internal public-proxy lookup only. Does not authorize access. */
  get(id: string): Promise<ShareRecord | null>;
  getOwned(identityId: string, id: string): Promise<ShareRecord | null>;
  listOwned(identityId: string, options?: ShareListOptions): Promise<ShareRecord[]>;
  /** Removes local metadata only, after upstream deletion succeeds. */
  removeOwned(identityId: string, id: string): Promise<boolean>;
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
export function validateShareUpsert(input: ShareUpsertInput): void {
  validateShareId(input.identityId);
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(input.sftpgoShareId))
    throw new TypeError("Invalid upstream share identifier");
  if (
    typeof input.name !== "string" ||
    input.name.length < 1 ||
    input.name.length > 255 ||
    /\p{Cc}/u.test(input.name)
  )
    throw new TypeError("Invalid share name");
  parseShareScope(input.scope);
  if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 1000)
    throw new TypeError("A share requires 1 to 1000 paths");
  for (const path of input.paths) validateSharePath(path);
  if (typeof input.hasPassword !== "boolean") throw new TypeError("Invalid password flag");
  if (!Number.isInteger(input.views) || input.views < 0 || input.views > 2_147_483_647)
    throw new TypeError("Invalid cached share views");
  validateDate(input.at);
  if (input.expiresAt !== null) validateDate(input.expiresAt);
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
    name: input.name,
    scope: input.scope,
    paths: [...input.paths],
    hasPassword: input.hasPassword,
    expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
    views: input.views,
  };
}
export function cloneShareRecord(record: ShareRecord): ShareRecord {
  return {
    ...record,
    paths: [...record.paths],
    createdAt: new Date(record.createdAt),
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt),
  };
}
export function compareShareRecords(a: ShareRecord, b: ShareRecord): number {
  const time = b.createdAt.getTime() - a.createdAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Test adapter. Upserts mutate synchronously, so concurrent promises retain one UUID. */
export function createMemoryShareRepo(options: MemoryShareOptions = {}): ShareRepo {
  const rows = new Map<string, ShareRecord>();
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
      return rows.delete(id);
    },
  };
}
