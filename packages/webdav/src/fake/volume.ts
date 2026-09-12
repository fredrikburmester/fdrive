import { isWithin, parentOf, segmentsOf } from "../path.js";

export interface FakeFile {
  readonly kind: "file";
  content: Uint8Array;
  contentType: string | null;
  modifiedAt: Date;
}

export interface FakeDir {
  readonly kind: "dir";
  modifiedAt: Date;
}

export type FakeNode = FakeFile | FakeDir;

/**
 * The in-memory tree behind the fake server: normalized provider paths to
 * nodes, the root always present. Ordinary tree operations only; HTTP
 * semantics (status codes, headers) belong to the server.
 */
export class FakeVolume {
  private readonly nodes = new Map<string, FakeNode>();
  private readonly now: () => Date;

  constructor(now: () => Date) {
    this.now = now;
    this.nodes.set("/", { kind: "dir", modifiedAt: now() });
  }

  get(path: string): FakeNode | undefined {
    return this.nodes.get(path);
  }

  has(path: string): boolean {
    return this.nodes.has(path);
  }

  isDir(path: string): boolean {
    return this.nodes.get(path)?.kind === "dir";
  }

  /** Every path in the tree, the root first, then depth-first in insertion order. */
  paths(): string[] {
    return [...this.nodes.keys()];
  }

  /** Direct members of the collection at `path`. */
  children(path: string): string[] {
    return this.paths().filter((candidate) => candidate !== "/" && parentOf(candidate) === path);
  }

  mkdir(path: string): void {
    this.nodes.set(path, { kind: "dir", modifiedAt: this.now() });
  }

  /** Creates every missing ancestor of `path` as a collection, then `path` itself. */
  mkdirAll(path: string): void {
    const segments = segmentsOf(path);
    let current = "";
    for (const segment of segments) {
      current = `${current}/${segment}`;
      if (!this.nodes.has(current)) this.mkdir(current);
    }
  }

  putFile(
    path: string,
    content: Uint8Array,
    options: { contentType?: string | null; modifiedAt?: Date } = {},
  ): void {
    this.nodes.set(path, {
      kind: "file",
      content,
      contentType: options.contentType ?? null,
      modifiedAt: options.modifiedAt ?? this.now(),
    });
  }

  /** Removes `path` and, for a collection, everything below it. */
  remove(path: string): void {
    for (const candidate of this.paths()) {
      if (isWithin(path, candidate)) this.nodes.delete(candidate);
    }
  }

  /**
   * Copies `source` to `target`. A collection is copied with its whole
   * subtree unless `shallow`, which copies only the collection itself.
   */
  copy(source: string, target: string, options: { shallow?: boolean } = {}): void {
    const node = this.nodes.get(source);
    if (node === undefined) return;
    if (node.kind === "file") {
      this.putFile(target, node.content.slice(), {
        contentType: node.contentType,
        modifiedAt: node.modifiedAt,
      });
      return;
    }
    this.mkdir(target);
    if (options.shallow === true) return;
    for (const [candidate, child] of [...this.nodes.entries()]) {
      if (candidate === source || !isWithin(source, candidate)) continue;
      const suffix = candidate.slice(source.length);
      if (child.kind === "dir") this.mkdir(`${target}${suffix}`);
      else
        this.putFile(`${target}${suffix}`, child.content.slice(), {
          contentType: child.contentType,
          modifiedAt: child.modifiedAt,
        });
    }
  }

  move(source: string, target: string): void {
    this.copy(source, target);
    this.remove(source);
  }
}
