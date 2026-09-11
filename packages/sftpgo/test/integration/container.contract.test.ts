import { createRecycleFolderTrash, withMoveToTrash } from "@fdrive/core";
import { describeStorageProvider, startSftpgo } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("generic directory Trash against real storage", () => {
  let container: Awaited<ReturnType<typeof startSftpgo>>;
  beforeAll(async () => {
    container = await startSftpgo();
  }, 180_000);
  afterAll(async () => {
    await container.stop();
  }, 180_000);

  it("restores numeric and long paths, empty directories, and purges a whole directory", async () => {
    const alice = container.users.find((user) => user.username === "alice");
    if (!alice) throw new Error("seed user alice missing");
    const client = createSftpgoClient({ baseUrl: container.baseUrl });
    const token = (await client.login(alice)).accessToken;
    const raw = createSftpgoStorageProvider({ client, withToken: (fn) => fn(token) });
    // The API factory also adapts providers whose mkdir rejects an existing directory.
    const storage = {
      ...raw,
      async mkdir(path: string, options?: { parents?: boolean }) {
        try {
          await raw.mkdir(path, options);
        } catch (error) {
          if ((await raw.stat(path).catch(() => null))?.kind !== "dir") throw error;
        }
      },
    };
    const wrapped = withMoveToTrash({
      storage,
      trashPath: "/.generic-trash",
      clock: () => new Date(),
    });
    const trash = createRecycleFolderTrash({
      storage: wrapped,
      trashPath: "/.generic-trash",
      layout: "move",
    });
    const original = `/generic/2026/Å %20/${"x".repeat(255)}`;
    await storage.mkdir(original, { parents: true });
    await storage.upload(`${original}/keep.txt`, new TextEncoder().encode("kept"));
    await wrapped.deleteDir(original);
    const item = (await trash.list()).entries.find((entry) => entry.originalPath === original);
    expect(item).toBeDefined();
    expect(await trash.restore(item?.id ?? "missing")).toMatchObject({
      path: original,
      kind: "dir",
    });
    const download = await storage.download(`${original}/keep.txt`);
    expect(await new Response(download.body).text()).toBe("kept");

    await storage.mkdir("/generic/empty");
    await wrapped.deleteDir("/generic/empty");
    const empty = (await trash.list()).entries.find(
      (entry) => entry.originalPath === "/generic/empty",
    );
    expect(await trash.restore(empty?.id ?? "missing")).toMatchObject({ kind: "dir" });
    expect(await storage.list("/generic/empty")).toEqual([]);

    await wrapped.deleteDir(original);
    const purge = (await trash.list()).entries.find((entry) => entry.originalPath === original);
    await trash.purge([purge?.id ?? "missing"]);
    expect((await trash.list()).entries).toEqual([]);
    await expect(storage.stat(original)).rejects.toMatchObject({ kind: "not_found" });
  });
});
