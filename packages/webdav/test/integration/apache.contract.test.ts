import { describeStorageProvider, startApacheWebdav } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebdavClient } from "../../src/client.js";
import { createWebdavStorageProvider } from "../../src/storage-provider.js";

describe("WebDAV against Apache mod_dav", () => {
  let server: Awaited<ReturnType<typeof startApacheWebdav>>;
  beforeAll(async () => {
    server = await startApacheWebdav();
  });
  afterAll(async () => {
    await server?.stop();
  });
  const storage = () =>
    createWebdavStorageProvider({
      client: createWebdavClient({ baseUrl: server.baseUrl }),
      credential: async () => server.credential,
    });
  describeStorageProvider("Apache", () => ({ storage: storage() }), { overwritesOnMove: true });
  it("handles collection redirects through copy, move, stat and delete", async () => {
    const provider = storage();
    await provider.mkdir("/slash/source", { parents: true });
    await provider.upload("/slash/source/file.txt", new TextEncoder().encode("preserved"));
    const redirect = await fetch(`${server.baseUrl}slash/source`, {
      method: "PROPFIND",
      redirect: "manual",
      headers: {
        Authorization: `Basic ${Buffer.from(`${server.credential.username}:${server.credential.password}`).toString("base64")}`,
      },
    });
    await redirect.body?.cancel();
    expect(redirect.status).toBe(301);
    await provider.copy("/slash/source", "/slash/copied");
    await provider.move("/slash/copied", "/slash/moved");
    expect((await provider.stat("/slash/moved")).kind).toBe("dir");
    expect(await new Response((await provider.download("/slash/moved/file.txt")).body).text()).toBe(
      "preserved",
    );
    await provider.deleteDir("/slash");
    await expect(provider.stat("/slash")).rejects.toMatchObject({ kind: "not_found" });
  });
});
