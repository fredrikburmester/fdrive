import { startSftpgo } from "@fdrive/testkit";
import { createSftpgoClient } from "../../src/client.js";
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
