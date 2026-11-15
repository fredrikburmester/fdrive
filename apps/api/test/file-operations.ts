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
import { createTrashItems, type TrashItems, type TrashItemsDeps } from "../src/trash/items.js";
import { type MemoryTrashItemRepo, memoryTrashItemRepo } from "./trash-items.js";

/** Where the memory access repository writes what follows. */
export interface MemoryAccessStores {
  readonly shares?: Pick<ShareRepo, "movePrefix" | "deletePrefix">;
  readonly grants?: Pick<LocalGrantRepo, "movePrefix" | "deletePrefix">;
  readonly office?: Pick<OfficeFileRepo, "movePrefix" | "deletePrefix">;
  /** Trash's rows, which change in the same transaction. */
  readonly trash?: MemoryTrashItemRepo;
}

/** Trash's rows for an access repository made without them: any change to them is a test's mistake. */
const noTrashRows: Pick<MemoryTrashItemRepo, "transaction"> = {
  transaction() {
    const missing = async (): Promise<never> => {
      throw new Error("this memoryAccessRepo has no Trash rows: pass { trash } to it");
    };
    return { changes: { entered: missing, left: missing }, commit() {} };
  },
};

/**
 * `AccessRepo` over memory repositories, for route tests. Like a
 * transaction, it keeps what `work` hands it only once `work` succeeded, and
 * nobody sees it before: a document's id moves with the rename that holds
 * its lock, not while the storage call runs. Trash's rows change the same
 * way. Failures in the transaction itself, and the path locks, are tested
 * against PostgreSQL (`test/integration`).
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
      const trash = (stores.trash ?? noTrashRows).transaction();
      const value = await work(async (change) => {
        pending.push(change);
      }, trash.changes);
      for (const change of pending) {
        await apply(change);
        changes.push(change);
      }
      trash.commit();
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

/** Each login's own files, for a test whose deletes never need settling. */
async function noHome(): Promise<StorageProvider> {
  throw new Error("no storage for this login in this test");
}

/** Trash's rows in memory and what reads and settles them, as `composition.ts` builds them. */
export function testTrashItems(
  options: {
    repo?: MemoryTrashItemRepo;
    access?: AccessFollowers;
    homeOf?: (identityId: string) => Promise<StorageProvider>;
    metadata?: TrashItemsDeps["metadata"];
  } = {},
): { repo: MemoryTrashItemRepo; items: TrashItems; access: AccessFollowers } {
  const repo = options.repo ?? memoryTrashItemRepo();
  const access = options.access ?? testAccessFollowers(memoryAccessRepo({ trash: repo }));
  const items = createTrashItems({
    repo,
    access,
    homeOf: options.homeOf ?? noHome,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  });
  return { repo, items, access };
}

export interface TestFileOperationsDeps extends Partial<FileOperationsDeps> {
  /** Trash's rows; a fresh memory repository unless given. */
  readonly trashRepo?: MemoryTrashItemRepo;
  /** Each login's own files, which settle a delete that failed. */
  readonly homeOf?: (identityId: string) => Promise<StorageProvider>;
}

/** The file operations as `composition.ts` builds them, over memory stores. */
export function testFileOperations(deps: TestFileOperationsDeps = {}): FileOperations {
  const ownerPath = deps.ownerPath ?? ownPath;
  const trashRepo = deps.trashRepo ?? memoryTrashItemRepo();
  const access =
    deps.access ?? testAccessFollowers(memoryAccessRepo({ trash: trashRepo }), { ownerPath });
  const trash =
    deps.trash ??
    testTrashItems({
      repo: trashRepo,
      access,
      ...(deps.homeOf === undefined ? {} : { homeOf: deps.homeOf }),
      ...(deps.metadata === undefined ? {} : { metadata: deps.metadata }),
    }).items;
  return createFileOperations({
    access,
    ownerPath,
    trash,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
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
    uploadPart(actor, path, body, options) {
      calls.push(`uploadPart ${path}`);
      return inner.uploadPart(actor, path, body, options);
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
