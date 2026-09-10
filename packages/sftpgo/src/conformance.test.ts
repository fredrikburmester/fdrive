import { describeStorageProvider } from "@fdrive/testkit";
import { createSftpgoClient } from "./client.js";
import { createFakeSftpgoServer } from "./fake/server.js";
import { createSftpgoStorageProvider } from "./storage-provider.js";

describeStorageProvider(
  "SFTPGo fake server",
  async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": ["*"] } }],
      files: { alice: {} },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = await client.login({ username: "alice", password: "secret" });
    const storage = createSftpgoStorageProvider({
      client,
      withToken: (fn) => fn(token.accessToken),
    });
    return { storage };
  },
  { overwritesOnMove: true },
);
