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

/** Joins a directory path and a single child name into a full path. */
function joinChildPath(dir: string, child: string): string {
  return dir === "/" ? `/${child}` : `${dir}/${child}`;
}

/** The final path segment of a normalized path. The basename of "/" is "". */
function basenameOf(path: string): string {
  const normalized = normalizePath(path);
  return normalized === "/" ? "" : normalized.slice(normalized.lastIndexOf("/") + 1);
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
   * The outcome of a move or copy. "unsupported" and "failure" mirror the
   * real drakkan/sftpgo:v2.7.5 container's file-actions API, verified
   * against the container directly: moving a file onto an existing
   * directory, or a directory onto an existing directory, answers 400
   * "operation unsupported"; moving a directory onto an existing file
   * answers 500. "conflict" covers every other already-occupied target
   * (file onto file overwrites and directory onto directory nests and
   * merges instead, see move()/copy(); a copy of a file onto a directory
   * or a directory onto a file was never exercised against the real
   * container, so the fake keeps the conservative 409 it always returned
   * there).
   */
  private relocate(
    path: string,
    target: string,
    keepSource: boolean,
  ): "ok" | "not_found" | "conflict" | "unsupported" | "failure" {
    const from = normalizePath(path);
    const to = normalizePath(target);
    const node = this.get(from);
    if (node === undefined) {
      return "not_found";
    }

    const existing = this.get(to);
    if (existing !== undefined) {
      return this.relocateOntoExisting(from, to, node, existing, keepSource);
    }

    this.ensureDir(dirnameOf(to));
    this.copyTree(from, to, node);
    if (!keepSource) {
      this.removeSource(from, node);
    }
    return "ok";
  }

  /**
   * Handles a move or copy whose target already exists. Only the six
   * combinations verified against the real container are given their exact
   * status; every other combination (a copy of a file onto a directory, or
   * a directory onto a file) keeps the fake's original "conflict" answer.
   */
  private relocateOntoExisting(
    from: string,
    to: string,
    node: VolumeNode,
    existing: VolumeNode,
    keepSource: boolean,
  ): "ok" | "conflict" | "unsupported" | "failure" {
    if (node.kind === "file") {
      if (existing.kind === "file") {
        if (!keepSource && from === to) {
          // Moving (or renaming) a file onto itself: verified against the real container, this
          // is rejected with 400, not treated as a no-op success or as data loss. Leaves the
          // file untouched.
          return "unsupported";
        }
        // move file -> existing file, or copy file -> existing file: overwrite the target.
        this.nodes.set(to, { kind: "file", content: node.content, mtimeMs: node.mtimeMs });
        if (!keepSource) {
          this.nodes.delete(from);
        }
        return "ok";
      }
      // move file -> existing dir is unsupported on the real container; copy file -> existing
      // dir was never verified there, so the fake keeps its original conflict answer.
      return keepSource ? "conflict" : "unsupported";
    }

    if (existing.kind === "file") {
      // move dir -> existing file fails on the real container; copy dir -> existing file was
      // never verified there, so the fake keeps its original conflict answer.
      return keepSource ? "conflict" : "failure";
    }

    if (keepSource) {
      return this.copyDirIntoExistingDir(from, to, node);
    }
    // move dir -> existing dir is unsupported on the real container.
    return "unsupported";
  }

  /**
   * Copies directory `from` into the already-existing directory `to`, the
   * way the real container's file-actions copy actually behaves (verified
   * against the container directly, since "merges" alone does not pin down
   * where): like Unix `cp -r`, the source is nested one level down, at
   * `to/<basename of from>`. When nothing is there yet, that nested
   * directory is created as a full copy of `from`. When a directory is
   * already there (for example, from an earlier copy), `from` is merged
   * into it: the nested directory keeps its own entries and `from`'s
   * entries overwrite same-named files. A file already at the nested
   * destination was never exercised against the real container, so the
   * fake keeps the conservative 409 it always returned there.
   */
  private copyDirIntoExistingDir(from: string, to: string, node: VolumeNode): "ok" | "conflict" {
    // basenameOf(from) is "" only when from is "/" itself, which has no name of its own to nest
    // under; normalizePath then collapses the resulting trailing slash back to `to`, so copying
    // the root merges its entries straight into the target instead of nesting them one level down.
    const nestedTo = normalizePath(joinChildPath(to, basenameOf(from)));
    const nestedExisting = this.get(nestedTo);
    if (nestedExisting === undefined) {
      this.copyTree(from, nestedTo, node);
      return "ok";
    }
    if (nestedExisting.kind === "dir") {
      this.mergeDirInto(from, nestedTo);
      return "ok";
    }
    return "conflict";
  }

  /** Copies `node` (a file, or a directory and everything under it) from `from` to `to`. */
  private copyTree(from: string, to: string, node: VolumeNode): void {
    if (node.kind === "file") {
      this.nodes.set(to, { kind: "file", content: node.content, mtimeMs: node.mtimeMs });
      return;
    }
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

  /**
   * Merges the directory at `from` into the already-existing directory at
   * `to`: every descendant directory of `from` is created at the matching
   * path under `to` unless something is already a directory there, and
   * every descendant file overwrites whatever (if anything) is at the
   * matching path under `to`. `to` itself, and anything under `to` with no
   * counterpart under `from`, is left untouched.
   */
  private mergeDirInto(from: string, to: string): void {
    const prefix = from === "/" ? "/" : `${from}/`;
    for (const [candidate, candidateNode] of [...this.nodes]) {
      if (!candidate.startsWith(prefix)) {
        continue;
      }
      const suffix = candidate.slice(prefix.length);
      const destination = to === "/" ? `/${suffix}` : `${to}/${suffix}`;
      if (candidateNode.kind === "file") {
        this.nodes.set(destination, {
          kind: "file",
          content: candidateNode.content,
          mtimeMs: candidateNode.mtimeMs,
        });
        continue;
      }
      const destinationNode = this.get(destination);
      if (destinationNode === undefined || destinationNode.kind !== "dir") {
        this.nodes.set(destination, { kind: "dir" });
      }
    }
  }

  private removeSource(from: string, node: VolumeNode): void {
    if (node.kind === "file") {
      this.nodes.delete(from);
    } else {
      this.deleteDir(from);
    }
  }

  /**
   * Moves a file or directory (and, for a directory, everything under it)
   * to a new path. Returns "not_found" when the source is missing. When
   * the target already exists, see relocate()'s doc comment for the exact
   * outcome per source/target kind.
   */
  move(path: string, target: string): "ok" | "not_found" | "conflict" | "unsupported" | "failure" {
    return this.relocate(path, target, false);
  }

  /** Copies a file or directory the same way move() relocates one, but keeps the source. */
  copy(path: string, target: string): "ok" | "not_found" | "conflict" | "unsupported" | "failure" {
    return this.relocate(path, target, true);
  }
}
