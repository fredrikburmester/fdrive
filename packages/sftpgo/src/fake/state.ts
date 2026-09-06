import { randomUUID } from "node:crypto";
import { normalizePath } from "../path.js";
import type { FakeSeed } from "./types.js";
import { Volume } from "./volume.js";

export interface FakeUserRecord {
  readonly username: string;
  readonly password: string;
  readonly permissions: Record<string, string[]>;
  readonly virtualFolders: readonly { name: string; virtualPath: string }[];
  readonly volume: Volume;
}

export interface FakeTokenRecord {
  readonly username: string;
  readonly expiresAtMs: number;
}

export interface FakeShareRecord {
  id: string;
  name: string;
  description: string;
  scope: number;
  paths: string[];
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUseAt: number;
  expiresAt: number;
  password: string;
  maxTokens: number;
  usedTokens: number;
  allowFrom: string[];
}

const DEFAULT_TOKEN_TTL_MS = 20 * 60 * 1000;

/** The in-memory state backing a FakeSftpgoServer, exposed for test assertions. */
export class FakeState {
  readonly users = new Map<string, FakeUserRecord>();
  readonly folders = new Map<string, Volume>();
  readonly tokens = new Map<string, FakeTokenRecord>();
  readonly shares = new Map<string, FakeShareRecord>();
  readonly tokenTtlMs: number;
  readonly now: () => Date;
  private nextId = 1;

  constructor(seed: FakeSeed) {
    this.tokenTtlMs = seed.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.now = seed.now ?? (() => new Date());

    for (const folder of seed.folders ?? []) {
      this.folders.set(folder.name, new Volume());
    }

    for (const user of seed.users) {
      this.users.set(user.username, {
        username: user.username,
        password: user.password,
        permissions: user.permissions,
        virtualFolders: user.virtualFolders ?? [],
        volume: new Volume(),
      });
    }

    for (const [ownerKey, files] of Object.entries(seed.files ?? {})) {
      for (const [virtualPath, content] of Object.entries(files)) {
        const bytes = new TextEncoder().encode(content);
        if (ownerKey.startsWith("@")) {
          const folder = this.folders.get(ownerKey.slice(1));
          if (folder) {
            folder.writeFile(virtualPath, bytes, this.now().getTime(), true);
          }
          continue;
        }
        const { volume, innerPath } = this.resolveVolume(ownerKey, virtualPath);
        volume.writeFile(innerPath, bytes, this.now().getTime(), true);
      }
    }
  }

  generateId(prefix: string): string {
    const id = `${prefix}${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  generateToken(): string {
    return `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  }

  /**
   * Resolves a path in a user's own virtual namespace to the volume that
   * actually stores it and the path within that volume. A path under one of
   * the user's virtual folder mounts is redirected into that folder's
   * shared volume; everything else stays in the user's own private volume.
   * The longest matching mount wins.
   */
  resolveVolume(username: string, path: string): { volume: Volume; innerPath: string } {
    const user = this.users.get(username);
    const normalized = normalizePath(path);
    if (!user) {
      return { volume: new Volume(), innerPath: normalized };
    }

    let bestMount: { name: string; virtualPath: string } | null = null;
    for (const mount of user.virtualFolders) {
      const mountPath = normalizePath(mount.virtualPath);
      const matches = normalized === mountPath || normalized.startsWith(`${mountPath}/`);
      if (matches && (bestMount === null || mountPath.length > bestMount.virtualPath.length)) {
        bestMount = mount;
      }
    }

    if (bestMount === null) {
      return { volume: user.volume, innerPath: normalized };
    }

    const folder = this.folders.get(bestMount.name);
    const mountPath = normalizePath(bestMount.virtualPath);
    const remainder = normalized.slice(mountPath.length);
    const innerPath = remainder === "" ? "/" : remainder;
    return { volume: folder ?? new Volume(), innerPath };
  }
}
