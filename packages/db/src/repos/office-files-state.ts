import { randomUUID } from "node:crypto";

export interface OfficeFileLocation {
  readonly providerId: string;
  readonly rootName: string;
  readonly path: string;
}
export interface OfficeFile extends OfficeFileLocation {
  readonly id: string;
  readonly createdAt: Date;
}
export interface OfficeFileMove {
  readonly providerId: string;
  readonly rootName: string;
  readonly from: string;
  readonly to: string;
  readonly at: Date;
}
export interface OfficeFileDelete extends OfficeFileLocation {
  readonly at: Date;
}
export interface OfficeFileRepo {
  ensure(location: OfficeFileLocation): Promise<OfficeFile>;
  get(id: string): Promise<OfficeFile | null>;
  movePrefix(move: OfficeFileMove): Promise<void>;
  deletePrefix(deletion: OfficeFileDelete): Promise<void>;
}
export interface MemoryOfficeFileOptions {
  readonly id?: () => string;
  readonly now?: () => Date;
}

export function validateOfficeId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new TypeError("Office ID must be a canonical UUID");
  }
}
export function validateOfficePath(path: string, allowRoot = false): void {
  if (allowRoot && path === "") return;
  if (
    path.includes("\0") ||
    path
      .split("/")
      .some(
        (part) =>
          part === "" || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255,
      )
  ) {
    throw new TypeError("Office path must be canonical and root-relative");
  }
}
export function validateOfficeLocation(location: OfficeFileLocation, allowRoot = false): void {
  validateOfficeId(location.providerId);
  if (!location.rootName || location.rootName.includes("\0"))
    throw new TypeError("Invalid office root");
  validateOfficePath(location.path, allowRoot);
}
function validateTime(at: Date): void {
  if (!Number.isFinite(at.getTime())) throw new TypeError("Invalid office timestamp");
}
export function officePathMatches(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}
export function validateOfficeMove(move: OfficeFileMove): void {
  validateOfficeLocation({ ...move, path: move.from }, true);
  validateOfficePath(move.to, true);
  validateTime(move.at);
  if (
    move.from !== move.to &&
    (officePathMatches(move.from, move.to) || officePathMatches(move.to, move.from))
  ) {
    throw new TypeError("Office move prefixes must not overlap");
  }
}
export function validateOfficeDelete(deletion: OfficeFileDelete): void {
  validateOfficeLocation(deletion, true);
  validateTime(deletion.at);
}
/** Input contains the matching source rows; disjoint prefixes avoid update-order dependencies. */
export function movedOfficeFiles(files: readonly OfficeFile[], move: OfficeFileMove): OfficeFile[] {
  return files.map((file) => ({ ...file, path: move.to + file.path.slice(move.from.length) }));
}
export function escapeOfficeLike(path: string): string {
  return path.replace(/[\\%_]/g, "\\$&");
}
function cloneFile(file: OfficeFile): OfficeFile {
  return { ...file, createdAt: new Date(file.createdAt) };
}

/** Test implementation. Synchronous mutations are atomic before promises resolve. */
export function createMemoryOfficeFileRepo(options: MemoryOfficeFileOptions = {}): OfficeFileRepo {
  const files = new Map<string, OfficeFile>();
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date());
  return {
    async ensure(location) {
      validateOfficeLocation(location);
      for (const file of files.values()) {
        if (
          file.providerId === location.providerId &&
          file.rootName === location.rootName &&
          file.path === location.path
        )
          return cloneFile(file);
      }
      const file = { ...location, id: id(), createdAt: new Date(now()) };
      files.set(file.id, file);
      return cloneFile(file);
    },
    async get(fileId) {
      validateOfficeId(fileId);
      const file = files.get(fileId);
      return file ? cloneFile(file) : null;
    },
    async movePrefix(move) {
      validateOfficeMove(move);
      if (move.from === move.to) return;
      const scoped = [...files.values()].filter(
        (file) => file.providerId === move.providerId && file.rootName === move.rootName,
      );
      const moved = movedOfficeFiles(
        scoped.filter((file) => officePathMatches(file.path, move.from)),
        move,
      );
      const destinations = new Set(moved.map((file) => file.path));
      for (const file of scoped) if (destinations.has(file.path)) files.delete(file.id);
      for (const file of moved) files.set(file.id, file);
    },
    async deletePrefix(deletion) {
      validateOfficeDelete(deletion);
      for (const file of files.values()) {
        if (
          file.providerId === deletion.providerId &&
          file.rootName === deletion.rootName &&
          officePathMatches(file.path, deletion.path)
        )
          files.delete(file.id);
      }
    },
  };
}
