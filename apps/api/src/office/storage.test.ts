import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryRepos } from "@fdrive/db/testing";
import { expect, it } from "vitest";
import { createIdentityStorageFactory } from "../auth/storage-factory.ts";
import {
  filesFolderFixture,
  seedLocalUsers,
  seedStorageRow,
} from "../local/test-fixtures/index.ts";
import { createOfficeStorageFactory } from "./storage.ts";

/** Alice's login over a temporary files folder holding `/a.docx`. */
async function fixture() {
  const repos = createMemoryRepos();
  const local = filesFolderFixture(repos);
  await mkdir(join(local.root, "alice"));
  await writeFile(join(local.root, "alice", "a.docx"), "hello");
  await seedStorageRow(repos);
  const [identity] = await seedLocalUsers(repos, [{ username: "alice", password: "alice-pass" }]);
  if (identity === undefined) throw new Error("unseeded");
  const factory = createOfficeStorageFactory(
    createIdentityStorageFactory({
      identities: repos.identities,
      folder: local.folder,
      clock: () => new Date(),
    }),
  );
  return { repos, identity, factory };
}

it("serves the owner's files to the editor", async () => {
  const h = await fixture();
  const storage = await h.factory(h.identity.id);
  expect((await storage.statFile("/a.docx")).size).toBe(5);
  await storage.upload("/a.docx", new TextEncoder().encode("saved"), { overwrite: true });
  expect(await new Response((await storage.download("/a.docx")).body).text()).toBe("saved");
});

it("fails closed with a 401 on a missing identity or a disabled user", async () => {
  const h = await fixture();
  await expect(h.factory("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
    status: 401,
  });
  await h.repos.localUsers.update("alice", { disabled: true });
  await expect(h.factory(h.identity.id)).rejects.toMatchObject({ status: 401 });
});
