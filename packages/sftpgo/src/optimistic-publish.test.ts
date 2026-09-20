import { StorageError, type StorageProvider, type StorageSession } from "@fdrive/core";
import { expect, it } from "vitest";
import { createSftpgoClient } from "./client.js";
import { createFakeSftpgoServer } from "./fake/server.js";
import { sftpgoModule } from "./module.js";
import { withOverwriteGuard } from "./optimistic-publish.js";

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

function guarded(stat: StorageProvider["stat"]) {
  const calls: string[] = [];
  const storage = {
    stat,
    upload: async () => {
      calls.push("upload");
    },
    move: async () => {
      calls.push("move");
    },
    copy: async () => {
      calls.push("copy");
    },
  } as unknown as StorageProvider;
  return { storage: withOverwriteGuard(storage), calls };
}

it("performs a guarded upload, move and copy when the target is absent", async () => {
  const absent: StorageProvider["stat"] = async () => {
    throw new StorageError("not_found", "gone");
  };
  const { storage, calls } = guarded(absent);

  await storage.upload("/new.txt", new Uint8Array([1]), { overwrite: false });
  await storage.move("/a.txt", "/b.txt", { overwrite: false });
  await storage.copy("/a.txt", "/c.txt", { overwrite: false });

  expect(calls).toEqual(["upload", "move", "copy"]);
});

it("rethrows a non-not_found stat failure and never runs the mutation", async () => {
  const denied: StorageProvider["stat"] = async () => {
    throw new StorageError("forbidden", "permission denied");
  };
  const { storage, calls } = guarded(denied);

  await expect(storage.move("/a.txt", "/b.txt", { overwrite: false })).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(calls).toEqual([]);
});

it("touches no stat at all when overwrite is not denied", async () => {
  const { storage, calls } = guarded(async () => {
    throw Error("stat must not run without overwrite: false");
  });

  await storage.upload("/new.txt", new Uint8Array([1]));

  expect(calls).toEqual(["upload"]);
});
