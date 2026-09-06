import { dirnameOf, normalizePath } from "../path.js";

export interface VolumeFileNode {
  readonly kind: "file";
  content: Uint8Array;
  mtimeMs: number;
}

export interface VolumeDirNode {
  readonly kind: "dir";
}

export type VolumeNode = VolumeFileNode | VolumeDirNode;

export interface VolumeEntry {
  readonly name: string;
  readonly node: VolumeNode;
}

/**
 * A minimal in-memory filesystem keyed by normalized absolute virtual path.
 * The root directory "/" always exists. Directories are explicit entries
 * (created by mkdir, ensureDir, or implicitly when a file is written with
 * mkdirParents); there are no implicit directories otherwise.
 */
export class Volume {
  private readonly nodes = new Map<string, VolumeNode>();

  constructor() {
    this.nodes.set("/", { kind: "dir" });
  }

  get(path: string): VolumeNode | undefined {
    return this.nodes.get(normalizePath(path));
  }

  has(path: string): boolean {
    return this.nodes.has(normalizePath(path));
  }

  isDir(path: string): boolean {
    const node = this.get(path);
    return node !== undefined && node.kind === "dir";
  }

  isFile(path: string): boolean {
    const node = this.get(path);
    return node !== undefined && node.kind === "file";
  }

  /** Creates a directory and every missing ancestor, like `mkdir -p`. */
  ensureDir(path: string): void {
    const normalized = normalizePath(path);
    if (normalized === "/") {
      return;
    }
    const parent = dirnameOf(normalized);
    if (!this.has(parent)) {
      this.ensureDir(parent);
    }
    if (!this.has(normalized)) {
      this.nodes.set(normalized, { kind: "dir" });
    }
  }

  /**
   * Creates a single directory. Returns "conflict" when something already
   * exists at that path, "not_found" when the parent is missing and
   * `parents` is false, otherwise creates it (and its ancestors, when
   * `parents` is true) and returns "ok".
   */
  mkdir(path: string, parents: boolean): "ok" | "conflict" | "not_found" {
    const normalized = normalizePath(path);
    if (this.has(normalized)) {
      return "conflict";
    }
    const parent = dirnameOf(normalized);
    if (!this.has(parent)) {
      if (!parents) {
        return "not_found";
      }
      this.ensureDir(parent);
    }
    this.nodes.set(normalized, { kind: "dir" });
    return "ok";
  }

  /**
   * Writes file content. Returns "bad_request" when the target is an
   * existing directory or when the parent path is not a directory,
   * "not_found" when the parent is missing and `mkdirParents` is false,
   * otherwise writes the file (creating missing ancestors when
   * `mkdirParents` is true) and returns "ok".
   */
  writeFile(
    path: string,
    content: Uint8Array,
    mtimeMs: number,
    mkdirParents: boolean,
  ): "ok" | "not_found" | "bad_request" {
    const normalized = normalizePath(path);
    if (this.isDir(normalized)) {
      return "bad_request";
    }
    const parent = dirnameOf(normalized);
    if (!this.has(parent)) {
      if (!mkdirParents) {
        return "not_found";
      }
      this.ensureDir(parent);
    } else if (!this.isDir(parent)) {
      return "bad_request";
    }
    this.nodes.set(normalized, { kind: "file", content, mtimeMs });
    return "ok";
  }

  /** Lists the direct children of a directory, or null if it is not a directory that exists. */
  listChildren(path: string): VolumeEntry[] | null {
    const normalized = normalizePath(path);
    if (!this.isDir(normalized)) {
      return null;
    }
    const entries: VolumeEntry[] = [];
    for (const [candidate, node] of this.nodes) {
      if (candidate === "/" || dirnameOf(candidate) !== normalized) {
        continue;
      }
      const name = candidate.slice(candidate.lastIndexOf("/") + 1);
      entries.push({ name, node });
    }
    return entries;
  }

  deleteFile(path: string): "ok" | "not_found" | "bad_request" {
    const normalized = normalizePath(path);
    const node = this.get(normalized);
    if (node === undefined) {
      return "not_found";
    }
    if (node.kind !== "file") {
      return "bad_request";
    }
    this.nodes.delete(normalized);
    return "ok";
  }

  /** Deletes a directory and everything under it, recursively. */
  deleteDir(path: string): "ok" | "not_found" | "bad_request" {
    const normalized = normalizePath(path);
    if (!this.has(normalized)) {
      return "not_found";
    }
    if (!this.isDir(normalized)) {
      return "bad_request";
    }
    // When normalized is "/" this is "/", but candidate !== normalized already excludes it below;
    // otherwise this can never equal "/", so root is never a false match for startsWith(prefix).
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    for (const candidate of [...this.nodes.keys()]) {
      if (candidate !== normalized && candidate.startsWith(prefix)) {
        this.nodes.delete(candidate);
      }
    }
    if (normalized !== "/") {
      this.nodes.delete(normalized);
    }
    return "ok";
  }

  setMtime(path: string, mtimeMs: number): "ok" | "not_found" | "bad_request" {
    const normalized = normalizePath(path);
    const node = this.get(normalized);
    if (node === undefined) {
      return "not_found";
    }
    if (node.kind !== "file") {
      return "bad_request";
    }
    node.mtimeMs = mtimeMs;
    return "ok";
  }

  /**
   * Moves a file or directory (and, for a directory, everything under it)
   * to a new path. Returns "not_found" when the source is missing,
   * "conflict" when something already exists at the target.
   */
  move(path: string, target: string): "ok" | "not_found" | "conflict" {
    return this.relocate(path, target, false);
  }

  /** Copies a file or directory the same way move() relocates one. */
  copy(path: string, target: string): "ok" | "not_found" | "conflict" {
    return this.relocate(path, target, true);
  }

  private relocate(
    path: string,
    target: string,
    keepSource: boolean,
  ): "ok" | "not_found" | "conflict" {
    const from = normalizePath(path);
    const to = normalizePath(target);
    const node = this.get(from);
    if (node === undefined) {
      return "not_found";
    }
    if (this.has(to)) {
      return "conflict";
    }
    this.ensureDir(dirnameOf(to));

    if (node.kind === "file") {
      this.nodes.set(to, { kind: "file", content: node.content, mtimeMs: node.mtimeMs });
    } else {
      this.nodes.set(to, { kind: "dir" });
      const prefix = from === "/" ? "/" : `${from}/`;
      for (const [candidate, candidateNode] of [...this.nodes]) {
        if (candidate.startsWith(prefix)) {
          const suffix = candidate.slice(prefix.length);
          const destination = to === "/" ? `/${suffix}` : `${to}/${suffix}`;
          this.nodes.set(
            destination,
            candidateNode.kind === "file"
              ? { kind: "file", content: candidateNode.content, mtimeMs: candidateNode.mtimeMs }
              : { kind: "dir" },
          );
        }
      }
    }

    if (!keepSource) {
      if (node.kind === "file") {
        this.nodes.delete(from);
      } else {
        this.deleteDir(from);
      }
    }
    return "ok";
  }
}
