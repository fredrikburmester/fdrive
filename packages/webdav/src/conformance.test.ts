import { describeStorageProvider } from "@fdrive/testkit";
import { createWebdavClient } from "./client.js";
import { createFakeWebdavServer, type FakeWebdavOptions } from "./fake/server.js";
import { createWebdavStorageProvider } from "./storage-provider.js";

const ALICE = { username: "alice", password: "secret" };

function factory(options: Partial<FakeWebdavOptions>, baseUrl: string) {
  return () => {
    const server = createFakeWebdavServer({ users: [ALICE], ...options });
    const client = createWebdavClient({ baseUrl, fetch: server.fetch });
    return {
      storage: createWebdavStorageProvider({ client, credential: async () => ALICE }),
    };
  };
}

describeStorageProvider("WebDAV fake server", factory({}, "http://webdav.test/"), {
  overwritesOnMove: true,
});

describeStorageProvider(
  "WebDAV fake server under a prefix with absolute hrefs",
  factory(
    { prefix: "/remote.php/dav", hrefStyle: "absolute" },
    "http://webdav.test/remote.php/dav",
  ),
  { overwritesOnMove: true },
);

describeStorageProvider(
  "WebDAV fake server with a default namespace",
  factory({ namespaceStyle: "default", prefix: "/dav/" }, "http://webdav.test/dav/"),
  { overwritesOnMove: true },
);
