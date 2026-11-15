import { randomUUID } from "node:crypto";

/** Where a document lies: its owner's login and the owner's own canonical path (`/a/b.docx`). */
export interface OfficeFileLocation {
  readonly identityId: string;
  readonly path: string;
}
export interface OfficeFile extends OfficeFileLocation {
  readonly id: string;
  readonly createdAt: Date;
}
/** `from` and everything under it moves to `to`, in the same owner's files or another's. */
export interface OfficeFileMove {
  readonly from: OfficeFileLocation;
  readonly to: OfficeFileLocation;
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
/** A canonical path below the owner's root: `/a/b`, never `/` itself. */
export function validateOfficePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path
      .slice(1)
      .split("/")
      .some(
        (part) =>
          part === "" || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255,
      )
  ) {
    throw new TypeError("Office path must be canonical and below the owner's root");
  }
}
export function validateOfficeLocation(location: OfficeFileLocation): void {
  validateOfficeId(location.identityId);
  validateOfficePath(location.path);
}
function validateTime(at: Date): void {
  if (!Number.isFinite(at.getTime())) throw new TypeError("Invalid office timestamp");
}
export function officePathMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
function sameLocation(a: OfficeFileLocation, b: OfficeFileLocation): boolean {
  return a.identityId === b.identityId && a.path === b.path;
}
export function validateOfficeMove(move: OfficeFileMove): void {
  validateOfficeLocation(move.from);
  validateOfficeLocation(move.to);
  validateTime(move.at);
  if (
    move.from.identityId === move.to.identityId &&
    !sameLocation(move.from, move.to) &&
    (officePathMatches(move.from.path, move.to.path) ||
      officePathMatches(move.to.path, move.from.path))
  ) {
    throw new TypeError("Office move prefixes must not overlap");
  }
}
export function validateOfficeDelete(deletion: OfficeFileDelete): void {
  validateOfficeLocation(deletion);
  validateTime(deletion.at);
}
/** Input contains the matching source rows; disjoint prefixes avoid update-order dependencies. */
export function movedOfficeFiles(files: readonly OfficeFile[], move: OfficeFileMove): OfficeFile[] {
  return files.map((file) => ({
    ...file,
    identityId: move.to.identityId,
    path: move.to.path + file.path.slice(move.from.path.length),
  }));
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
  const under = (file: OfficeFile, prefix: OfficeFileLocation) =>
    file.identityId === prefix.identityId && officePathMatches(file.path, prefix.path);
  return {
    async ensure(location) {
      validateOfficeLocation(location);
      for (const file of files.values()) {
        if (sameLocation(file, location)) return cloneFile(file);
      }
      const file = {
        identityId: location.identityId,
        path: location.path,
        id: id(),
        createdAt: new Date(now()),
      };
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
      if (sameLocation(move.from, move.to)) return;
      const all = [...files.values()];
      const moved = movedOfficeFiles(
        all.filter((file) => under(file, move.from)),
        move,
      );
      const destinations = new Set(moved.map((file) => file.path));
      for (const file of all)
        if (file.identityId === move.to.identityId && destinations.has(file.path))
          files.delete(file.id);
      for (const file of moved) files.set(file.id, file);
    },
    async deletePrefix(deletion) {
      validateOfficeDelete(deletion);
      for (const file of files.values()) if (under(file, deletion)) files.delete(file.id);
    },
  };
}
