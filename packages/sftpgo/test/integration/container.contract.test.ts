import { describeStorageProvider, startSftpgo } from "@fdrive/testkit";
import { afterAll, beforeAll, describe } from "vitest";
import { createSftpgoClient } from "../../src/client.js";
import { createSftpgoStorageProvider } from "../../src/storage-provider.js";
import type { ContractTarget } from "../contract/suite.js";
import { defineSftpgoContract, TRASH_PATH } from "../contract/suite.js";

async function setup(): Promise<ContractTarget> {
  const container = await startSftpgo({ trash: { path: TRASH_PATH } });
  const client = createSftpgoClient({ baseUrl: container.baseUrl });

  return {
    client,
    users: container.users,
    trashPath: TRASH_PATH,
    async teardown() {
      await container.stop();
    },
  };
}

defineSftpgoContract("container", setup);

/**
 * The provider-neutral behavioural contract, against a real SFTPGo: what
 * `describeStorageProvider` proves on the fake must hold on the server the
 * fake imitates.
 */
describe("StorageProvider conformance against the container", () => {
  let container: Awaited<ReturnType<typeof startSftpgo>>;
  let token: string;

  beforeAll(async () => {
    container = await startSftpgo();
    const alice = container.users.find((user) => user.username === "alice");
    if (alice === undefined) throw new Error("seed user alice missing");
    const client = createSftpgoClient({ baseUrl: container.baseUrl });
    token = (await client.login({ username: alice.username, password: alice.password }))
      .accessToken;
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 180_000);

  describeStorageProvider(
    "SFTPGo container",
    () => ({
      storage: createSftpgoStorageProvider({
        client: createSftpgoClient({ baseUrl: container.baseUrl }),
        withToken: (fn) => fn(token),
      }),
    }),
    { overwritesOnMove: true },
  );
});
