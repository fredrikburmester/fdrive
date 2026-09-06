import { startSftpgo } from "@fdrive/testkit";
import { createSftpgoClient } from "../../src/client.js";
import type { ContractTarget } from "../contract/suite.js";
import { defineSftpgoContract } from "../contract/suite.js";

async function setup(): Promise<ContractTarget> {
  const container = await startSftpgo();
  const client = createSftpgoClient({ baseUrl: container.baseUrl });

  return {
    client,
    users: container.users,
    async teardown() {
      await container.stop();
    },
  };
}

defineSftpgoContract("container", setup);
