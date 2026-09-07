import { SEED_FILES, SEED_FOLDERS, SEED_USERS } from "@fdrive/testkit";
import { createSftpgoClient } from "../../src/client.js";
import { createFakeSftpgoServer } from "../../src/fake/server.js";
import type { FakeSeed } from "../../src/fake/types.js";
import type { ContractTarget } from "./suite.js";
import { defineSftpgoContract, TRASH_PATH } from "./suite.js";

/**
 * Builds the fake server's seed from the same @fdrive/testkit constants the
 * container uses, so the two contract targets start from identical data.
 * FakeSeedUser and SeedUser are structurally identical; this maps between
 * them explicitly rather than relying on structural assignability of
 * readonly arrays. Enables the same recycle-folder trash the container is
 * seeded with, so the shared contract's trash scenarios run against both.
 */
function buildFakeSeed(): FakeSeed {
  return {
    users: SEED_USERS.map((user) => ({
      username: user.username,
      password: user.password,
      permissions: user.permissions,
      virtualFolders: user.virtualFolders,
    })),
    folders: SEED_FOLDERS.map((folder) => ({ name: folder.name })),
    files: SEED_FILES,
    trash: { path: TRASH_PATH },
  };
}

async function setup(): Promise<ContractTarget> {
  const server = createFakeSftpgoServer(buildFakeSeed());

  let callCount = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    callCount += 1;
    return server.fetch(input, init);
  };

  const client = createSftpgoClient({ baseUrl: "http://sftpgo.fake", fetch: countingFetch });

  return {
    client,
    users: SEED_USERS,
    trashPath: TRASH_PATH,
    fetchCallCount: () => callCount,
    async teardown() {
      // The in-memory fake owns no external resources to release.
    },
  };
}

defineSftpgoContract("fake", setup);
