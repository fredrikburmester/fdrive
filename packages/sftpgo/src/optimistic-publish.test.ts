import type { StorageSession } from "@fdrive/core";
import { expect, it } from "vitest";
import { createSftpgoClient } from "./client.js";
import { createFakeSftpgoServer } from "./fake/server.js";
import { sftpgoModule } from "./module.js";

const baseUrl = "http://sftpgo.test/prefix";

async function fixture() {
  const fake = createFakeSftpgoServer({
    users: [{ username: "alice", password: "secret", permissions: { "/": ["*"] } }],
    files: { alice: { "/original.txt": "original" } },
  });
  const jwt = await createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: fake.fetch }).login({
    username: "alice",
    password: "secret",
  });
  const calls: { url: string; method: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET" });
    // The fake receives an unprefixed path, mirroring a reverse proxy.
    return fake.fetch(String(input).replace("/prefix/api/", "/api/"), init);
  };
  const session: StorageSession = {
    externalUsername: "alice",
    getCredential: async () => ({ password: "secret" }),
    getToken: async () => jwt.accessToken,
    invalidateToken: async () => {},
  };
  return { fetch, calls, session };
}

it("never exposes a storage lease, whatever a stored row still says", async () => {
  const f = await fixture();
  // Rows saved before the write-mode selector was retired still carry its value.
  for (const config of [
    {},
    { desktopWriteMode: "" },
    { desktopWriteMode: "verified-optimistic" },
    { desktopWriteMode: "apache-webdav-exclusive" },
    { desktopWriteMode: "fdrive-local-v1" },
  ]) {
    expect(
      sftpgoModule.createStorage({ id: "p", baseUrl, config }, f.session, { fetch: f.fetch })
        .withWriteLease,
    ).toBeUndefined();
  }
  expect(f.calls).toEqual([]);
});

it("emulates overwrite refusal on stock REST without any configuration", async () => {
  const f = await fixture();
  const stock = sftpgoModule.createStorage({ id: "p", baseUrl, config: {} }, f.session, {
    fetch: f.fetch,
  });
  // Stock REST renames over an existing target, so `overwrite: false` has to be
  // emulated here or the publish path's guards are no-ops on this storage.
  await expect(
    stock.upload("/original.txt", new Blob(["mine"]).stream(), { overwrite: false }),
  ).rejects.toMatchObject({ kind: "conflict" });
  await expect(
    stock.move("/missing.txt", "/original.txt", { overwrite: false }),
  ).rejects.toMatchObject({ kind: "conflict" });
  await expect(
    stock.copy("/missing.txt", "/original.txt", { overwrite: false }),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(f.calls.map((call) => call.method)).toEqual(["HEAD", "HEAD", "HEAD"]);
});
