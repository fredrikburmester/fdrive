import type { StorageProvider } from "@fdrive/core";
import type {
  AccessChange,
  AccessRepo,
  LocalGrantRepo,
  OfficeFileRepo,
  PathLock,
  ShareRepo,
} from "@fdrive/db";
import {
  type AccessFollowers,
  createAccessFollowers,
  type OwnerPath,
} from "../src/files/access.js";
import {
  createFileOperations,
  type FileOperations,
  type FileOperationsDeps,
} from "../src/files/operations.js";
import { createShareMoves } from "../src/shares/moves.js";

/** Where the memory access repository writes what follows. */
export interface MemoryAccessStores {
  readonly shares?: Pick<ShareRepo, "movePrefix" | "deletePrefix">;
  readonly grants?: Pick<LocalGrantRepo, "movePrefix" | "deletePrefix">;
  readonly office?: Pick<OfficeFileRepo, "movePrefix" | "deletePrefix">;
}

/**
 * `AccessRepo` over memory repositories, for route tests. Like a
 * transaction, it keeps what `work` hands it only once `work` succeeded, and
 * nobody sees it before: a document's id moves with the rename that holds
 * its lock, not while the storage call runs. Failures in the transaction
 * itself, and the path locks, are tested against PostgreSQL
 * (`test/integration`).
 */
export function memoryAccessRepo(
  stores: MemoryAccessStores = {},
  clock: () => Date = () => new Date(),
): AccessRepo & { readonly changes: AccessChange[]; readonly locks: PathLock[][] } {
  const changes: AccessChange[] = [];
  const locks: PathLock[][] = [];
  async function apply(change: AccessChange): Promise<void> {
    const { directory, shares, grants, office } = change;
    if (shares !== null) {
      if (shares.to === null)
        await stores.shares?.deletePrefix(shares.identityId, shares.from, directory);
      else await stores.shares?.movePrefix(shares.identityId, shares.from, shares.to, directory);
    }
    if (grants !== null) {
      if (grants.to === null) await stores.grants?.deletePrefix(grants.owner, grants.from);
      else await stores.grants?.movePrefix(grants.owner, grants.from, grants.to);
    }
    if (office !== null) {
      if (office.to === null) await stores.office?.deletePrefix({ ...office.from, at: clock() });
      else await stores.office?.movePrefix({ from: office.from, to: office.to, at: clock() });
    }
  }
  return {
    changes,
    locks,
    async run(held, work) {
      locks.push([...held]);
      const pending: AccessChange[] = [];
      const value = await work(async (change) => {
        pending.push(change);
      });
      for (const change of pending) {
        await apply(change);
        changes.push(change);
      }
      return value;
    },
  };
}

const ownPath: OwnerPath = async (identityId, path) => ({ identityId, path });

/** Access followers over `repo`, every path its login's own unless `ownerPath` says otherwise. */
export function testAccessFollowers(
  repo: AccessRepo = memoryAccessRepo(),
  options: {
    ownerPath?: OwnerPath;
    usernameOf?: (identityId: string) => Promise<string | null>;
  } = {},
): AccessFollowers {
  const ownerPath = options.ownerPath ?? ownPath;
  return createAccessFollowers({
    repo,
    ownerPath,
    links: createShareMoves({ ownerPath }).resolve,
    usernameOf: options.usernameOf ?? (async () => null),
  });
}

/** The file operations as `composition.ts` builds them, over memory stores. */
export function testFileOperations(deps: Partial<FileOperationsDeps> = {}): FileOperations {
  const ownerPath = deps.ownerPath ?? ownPath;
  return createFileOperations({
    access: deps.access ?? testAccessFollowers(memoryAccessRepo(), { ownerPath }),
    ownerPath,
    storageFor:
      deps.storageFor ??
      (async (): Promise<StorageProvider> => {
        throw new Error("no storage for another login in this test");
      }),
    ...(deps.activity === undefined ? {} : { activity: deps.activity }),
    ...(deps.metadata === undefined ? {} : { metadata: deps.metadata }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
}

/**
 * `inner`, noting each operation it runs as `"<operation> <path>"`, so a
 * test can see that a caller changes files through the file operations.
 */
export function recordingFileOperations(inner: FileOperations = testFileOperations()): {
  readonly files: FileOperations;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const files: FileOperations = {
    upload(actor, path, body, options) {
      calls.push(`upload ${path}`);
      return inner.upload(actor, path, body, options);
    },
    mkdir(actor, path, options) {
      calls.push(`mkdir ${path}`);
      return inner.mkdir(actor, path, options);
    },
    move(actor, path, target, options) {
      calls.push(`move ${path}`);
      return inner.move(actor, path, target, options);
    },
    copy(actor, path, target, options) {
      calls.push(`copy ${path}`);
      return inner.copy(actor, path, target, options);
    },
    trash(actor, path) {
      calls.push(`trash ${path}`);
      return inner.trash(actor, path);
    },
    restore(actor, id, target) {
      calls.push(`restore ${id}`);
      return inner.restore(actor, id, target);
    },
    purge(actor, id, options) {
      calls.push(`purge ${id}`);
      return inner.purge(actor, id, options);
    },
  };
  return { files, calls };
}
