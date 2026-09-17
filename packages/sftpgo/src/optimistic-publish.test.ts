import type { StorageSession } from "@fdrive/core";
import { expect, it } from "vitest";
import { createSftpgoClient } from "./client.js";
import { createFakeSftpgoServer } from "./fake/server.js";
import { sftpgoModule } from "./module.js";
import { SFTPGO_OPTIMISTIC_MODE } from "./optimistic-publish.js";

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

it("never exposes a storage lease, whatever the configured mode", async () => {
  const f = await fixture();
  for (const mode of [
    undefined,
    "",
    "optimistic",
    "apache-webdav-exclusive",
    "fdrive-local-v1",
    SFTPGO_OPTIMISTIC_MODE,
  ]) {
    expect(
      sftpgoModule.createStorage(
        { id: "p", baseUrl, config: { desktopWriteMode: mode } },
        f.session,
        { fetch: f.fetch },
      ).withWriteLease,
    ).toBeUndefined();
  }
  expect(f.calls).toEqual([]);
});

it("offers optimistic publication for stock SFTPGo and stays read-only otherwise", async () => {
  const f = await fixture();
  const stock = sftpgoModule.createStorage(
    { id: "p", baseUrl, config: { desktopWriteMode: SFTPGO_OPTIMISTIC_MODE } },
    f.session,
    { fetch: f.fetch },
  );
  expect(stock.optimisticPublish).toBe(true);
  // A blank, unknown, near-miss or retired mode stays read-only rather than degrading to it.
  for (const mode of [undefined, "", "optimistic", "fdrive-local-v1", "fdrive-local-v2"]) {
    expect(
      sftpgoModule.createStorage(
        { id: "p", baseUrl, config: { desktopWriteMode: mode } },
        f.session,
        { fetch: f.fetch },
      ).optimisticPublish,
    ).toBeUndefined();
  }
  expect(f.calls).toEqual([]);
  // Stock REST renames over an existing target, so `overwrite: false` has to be
  // emulated here too or the publish path's guards are no-ops on this storage.
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
