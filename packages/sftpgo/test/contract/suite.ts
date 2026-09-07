import type { SeedUser } from "@fdrive/testkit";
import { SEED_FILES } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SftpgoError } from "../../src/errors.js";
import type { SftpgoClient, SftpgoEntry, SftpgoUserApi } from "../../src/types.js";
import { parseZipCentralDirectory } from "./zip-parser.js";

/**
 * One target the shared contract runs against: either the in-memory fake
 * server or a real `drakkan/sftpgo` container. Both are seeded from the
 * same @fdrive/testkit constants, so every `it` below must hold for both.
 *
 * `fetchCallCount`, when present, lets the client-side path validation
 * tests confirm that a rejected path never reaches the network. It is set
 * by the fake target (which wraps its own fetch to count calls); the
 * container target omits it, and those tests fall back to asserting only
 * the thrown error's kind.
 */
export interface ContractTarget {
  readonly client: SftpgoClient;
  readonly users: readonly SeedUser[];
  /** The virtual path both targets seed their recycle-folder trash rule at. */
  readonly trashPath: string;
  teardown(): Promise<void>;
  fetchCallCount?(): number;
}

/** The recycle-folder trash path both contract targets are seeded with. */
export const TRASH_PATH = "/.trash";

const HOOK_TIMEOUT_MS = 180_000;

function findUser(users: readonly SeedUser[], username: string): SeedUser {
  const user = users.find((candidate) => candidate.username === username);
  if (!user) {
    throw new Error(`Seed user "${username}" not found among the contract target's users`);
  }
  return user;
}

async function loginAs(client: SftpgoClient, user: SeedUser): Promise<string> {
  const token = await client.login({ username: user.username, password: user.password });
  return token.accessToken;
}

/**
 * Creates every missing ancestor directory of `path`, one level at a time.
 * Checks for existence with `list` rather than reacting to an error from
 * `mkdir`, because mkdir on an already-existing directory reports kind
 * "server" on both targets (see the "mkdir" describe block below), which
 * would not distinguish "already exists" from a genuine failure. This
 * helper needs to tolerate a directory that a previous test already
 * created.
 */
async function ensureDir(user: SftpgoUserApi, path: string): Promise<void> {
  if (path === "/") {
    return;
  }
  const lastSlash = path.lastIndexOf("/");
  const parent = lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
  await ensureDir(user, parent);
  try {
    await user.list(path);
    return;
  } catch (error) {
    if (!(error instanceof SftpgoError) || error.kind !== "not_found") {
      throw error;
    }
  }
  await user.mkdir(path);
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function truncateToSecond(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function expectDirEntry(entries: readonly SftpgoEntry[], name: string): void {
  const entry = entries.find((candidate) => candidate.name === name);
  expect(entry?.kind).toBe("dir");
}

function expectFileEntry(
  entries: readonly SftpgoEntry[],
  name: string,
  expectedContent: string,
): void {
  const entry = entries.find((candidate) => candidate.name === name);
  expect(entry?.kind).toBe("file");
  expect(entry?.size).toBe(encode(expectedContent).length);
  expect(entry?.modifiedAt).toBeInstanceOf(Date);
  expect(Number.isNaN(entry?.modifiedAt.getTime())).toBe(false);
}

/**
 * Registers the shared SFTPGo contract as a vitest describe block. `name`
 * identifies the target in test output ("fake" or "container"); every `it`
 * in the suite runs identically against both.
 */
export function defineSftpgoContract(name: string, setup: () => Promise<ContractTarget>): void {
  describe(`SFTPGo contract (${name})`, () => {
    let target: ContractTarget;

    beforeAll(async () => {
      target = await setup();
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await target.teardown();
    }, HOOK_TIMEOUT_MS);

    describe("login and logout", () => {
      it("rejects a bad password with kind unauthorized", async () => {
        const alice = findUser(target.users, "alice");
        await expect(
          target.client.login({ username: alice.username, password: "definitely-wrong" }),
        ).rejects.toMatchObject({ kind: "unauthorized" });
      });

      it("logs in successfully and returns a token expiring in the future", async () => {
        const alice = findUser(target.users, "alice");
        const before = Date.now();
        const token = await target.client.login({
          username: alice.username,
          password: alice.password,
        });
        expect(token.accessToken.length).toBeGreaterThan(0);
        expect(token.expiresAt.getTime()).toBeGreaterThan(before);
      });

      it("invalidates the token on logout", async () => {
        const alice = findUser(target.users, "alice");
        const accessToken = await loginAs(target.client, alice);
        await target.client.logout(accessToken);
        await expect(target.client.user(accessToken).list("/")).rejects.toMatchObject({
          kind: "unauthorized",
        });
      });
    });

    describe("listing the seeded root", () => {
      it("lists alice's root with seeded dirs and files", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const entries = await target.client.user(token).list("/");
        expectDirEntry(entries, "docs");
        expectFileEntry(entries, "photo.jpg", SEED_FILES.alice?.["/photo.jpg"] ?? "");
      });

      it("lists bob's root with seeded dirs", async () => {
        const bob = findUser(target.users, "bob");
        const token = await loginAs(target.client, bob);
        const entries = await target.client.user(token).list("/");
        expectDirEntry(entries, "inbox");
        expectDirEntry(entries, "public");
      });

      it("lists carol's root with her own seeded file", async () => {
        const carol = findUser(target.users, "carol");
        const token = await loginAs(target.client, carol);
        const rootEntries = await target.client.user(token).list("/");
        expectFileEntry(rootEntries, "own.txt", SEED_FILES.carol?.["/own.txt"] ?? "");
      });

      it("carol's root shows the shared virtual folder mount as a dir", async () => {
        const carol = findUser(target.users, "carol");
        const token = await loginAs(target.client, carol);
        const rootEntries = await target.client.user(token).list("/");
        expectDirEntry(rootEntries, "shared");
      });

      it("lists /shared with team.txt for carol", async () => {
        const carol = findUser(target.users, "carol");
        const token = await loginAs(target.client, carol);
        const sharedEntries = await target.client.user(token).list("/shared");
        expectFileEntry(sharedEntries, "team.txt", SEED_FILES["@shared"]?.["/team.txt"] ?? "");
      });
    });

    describe("statFile and download", () => {
      it("statFile returns the size of a seeded file", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const stat = await target.client.user(token).statFile("/docs/readme.md");
        expect(stat.size).toBe(encode(SEED_FILES.alice?.["/docs/readme.md"] ?? "").length);
      });

      it("statFile on a missing path throws not_found", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        await expect(
          target.client.user(token).statFile("/does-not-exist.txt"),
        ).rejects.toMatchObject({ kind: "not_found" });
      });

      it("download of a directory path throws bad_request", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        await expect(target.client.user(token).download("/docs")).rejects.toMatchObject({
          kind: "bad_request",
        });
      });

      it("downloads the full content matching the seed", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const result = await target.client.user(token).download("/docs/readme.md");
        expect(result.status).toBe(200);
        const bytes = await collectStream(result.body);
        expect(bytes).toEqual(encode(SEED_FILES.alice?.["/docs/readme.md"] ?? ""));
      });

      it("downloads a byte range with a start and an end", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const content = encode(SEED_FILES.alice?.["/docs/readme.md"] ?? "");
        const result = await target.client
          .user(token)
          .download("/docs/readme.md", { range: { start: 2, end: 4 } });
        expect(result.status).toBe(206);
        expect(result.contentRange).toBe(`bytes 2-4/${content.length}`);
        expect(await collectStream(result.body)).toEqual(content.slice(2, 5));
      });

      it("downloads a byte range with only a start", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const content = encode(SEED_FILES.alice?.["/docs/readme.md"] ?? "");
        const result = await target.client
          .user(token)
          .download("/docs/readme.md", { range: { start: 5 } });
        expect(result.status).toBe(206);
        expect(result.contentRange).toBe(`bytes 5-${content.length - 1}/${content.length}`);
        expect(await collectStream(result.body)).toEqual(content.slice(5));
      });
    });

    describe("upload", () => {
      it("uploads a new file with mkdirParents into a brand new nested directory", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        const dir = "/contract/upload-mkdir-parents/very/deep/nested";
        const path = `${dir}/file.txt`;
        const content = encode("uploaded with mkdirParents");
        const modifiedAt = new Date("2024-02-02T03:04:05.000Z");

        await user.upload(path, content, { mkdirParents: true, modifiedAt });

        const entries = await user.list(dir);
        const entry = entries.find((candidate) => candidate.name === "file.txt");
        expect(entry?.size).toBe(content.length);
        expect(truncateToSecond(entry?.modifiedAt as Date)).toBe(truncateToSecond(modifiedAt));

        const result = await user.download(path);
        expect(await collectStream(result.body)).toEqual(content);
      });

      it("uploads a ReadableStream body", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/upload-stream-body");
        const path = "/contract/upload-stream-body/file.txt";
        const content = encode("uploaded from a stream");

        await user.upload(path, toReadableStream(content));

        const result = await user.download(path);
        expect(await collectStream(result.body)).toEqual(content);
      });
    });

    describe("overwrite", () => {
      it("overwrites the content of an existing file", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/overwrite");
        const path = "/contract/overwrite/file.txt";

        await user.upload(path, encode("original content"));
        await user.upload(path, encode("replaced content"));

        const result = await user.download(path);
        expect(await collectStream(result.body)).toEqual(encode("replaced content"));
      });
    });

    describe("mkdir", () => {
      it("creates a new directory", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/mkdir-creates");
        await user.mkdir("/contract/mkdir-creates/newdir");
        const entries = await user.list("/contract/mkdir-creates");
        expectDirEntry(entries, "newdir");
      });

      it("mkdir on an already-existing directory fails with the real server's error kind", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/mkdir-conflict");
        await expect(user.mkdir("/contract/mkdir-conflict")).rejects.toMatchObject({
          kind: "server",
        });
      });
    });

    describe("move, copy, and delete", () => {
      it("moves a file", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/move-file");
        await user.upload("/contract/move-file/source.txt", encode("move me"));
        await user.move("/contract/move-file/source.txt", "/contract/move-file/target.txt");
        const entries = await user.list("/contract/move-file");
        const names = entries.map((entry) => entry.name);
        expect(names).not.toContain("source.txt");
        expect(names).toContain("target.txt");
      });

      it("moves a directory", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/move-dir/source");
        await user.upload("/contract/move-dir/source/file.txt", encode("inside a moved dir"));
        await user.move("/contract/move-dir/source", "/contract/move-dir/moved");
        const parentEntries = await user.list("/contract/move-dir");
        const names = parentEntries.map((entry) => entry.name);
        expect(names).not.toContain("source");
        expect(names).toContain("moved");
        const movedEntries = await user.list("/contract/move-dir/moved");
        expect(movedEntries.map((entry) => entry.name)).toContain("file.txt");
      });

      it("copies a file", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/copy-file");
        await user.upload("/contract/copy-file/source.txt", encode("copy me"));
        await user.copy("/contract/copy-file/source.txt", "/contract/copy-file/target.txt");
        const entries = await user.list("/contract/copy-file");
        const names = entries.map((entry) => entry.name);
        expect(names).toContain("source.txt");
        expect(names).toContain("target.txt");
      });

      it("copies a directory", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/copy-dir/source");
        await user.upload("/contract/copy-dir/source/file.txt", encode("inside a copied dir"));
        await user.copy("/contract/copy-dir/source", "/contract/copy-dir/copied");
        const parentEntries = await user.list("/contract/copy-dir");
        const names = parentEntries.map((entry) => entry.name);
        expect(names).toContain("source");
        expect(names).toContain("copied");
        const copiedEntries = await user.list("/contract/copy-dir/copied");
        expect(copiedEntries.map((entry) => entry.name)).toContain("file.txt");
      });

      it("deletes a file", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/delete-file");
        await user.upload("/contract/delete-file/file.txt", encode("delete me"));
        await user.deleteFile("/contract/delete-file/file.txt");
        const entries = await user.list("/contract/delete-file");
        expect(entries.map((entry) => entry.name)).not.toContain("file.txt");
      });

      it("deletes a non-empty directory recursively", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/delete-dir/inner");
        await user.upload("/contract/delete-dir/inner/file.txt", encode("delete recursively"));
        await user.deleteDir("/contract/delete-dir/inner");
        const entries = await user.list("/contract/delete-dir");
        expect(entries.map((entry) => entry.name)).not.toContain("inner");
      });

      it("deleteFile on a missing path throws not_found", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        await ensureDir(target.client.user(token), "/contract/delete-file-missing");
        await expect(
          target.client.user(token).deleteFile("/contract/delete-file-missing/does-not-exist.txt"),
        ).rejects.toMatchObject({ kind: "not_found" });
      });

      // The following six cases pin the real drakkan/sftpgo:v2.7.5 container's
      // exact behaviour on an already-occupied move/copy target, verified
      // directly against the container: it does not raise a conflict the way
      // the fake used to for every occupied target.

      it("moves a file onto an existing file: overwrites the target and removes the source", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/move-onto-file");
        await user.upload("/contract/move-onto-file/source.txt", encode("source content"));
        await user.upload("/contract/move-onto-file/target.txt", encode("old target content"));

        await user.move(
          "/contract/move-onto-file/source.txt",
          "/contract/move-onto-file/target.txt",
        );

        const names = (await user.list("/contract/move-onto-file")).map((entry) => entry.name);
        expect(names).not.toContain("source.txt");
        expect(names).toContain("target.txt");
        const result = await user.download("/contract/move-onto-file/target.txt");
        expect(await collectStream(result.body)).toEqual(encode("source content"));
      });

      it("copies a file onto an existing file: overwrites the target and keeps the source", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/copy-onto-file");
        await user.upload("/contract/copy-onto-file/source.txt", encode("source content"));
        await user.upload("/contract/copy-onto-file/target.txt", encode("old target content"));

        await user.copy(
          "/contract/copy-onto-file/source.txt",
          "/contract/copy-onto-file/target.txt",
        );

        const names = (await user.list("/contract/copy-onto-file")).map((entry) => entry.name);
        expect(names).toContain("source.txt");
        expect(names).toContain("target.txt");
        const source = await user.download("/contract/copy-onto-file/source.txt");
        expect(await collectStream(source.body)).toEqual(encode("source content"));
        const result = await user.download("/contract/copy-onto-file/target.txt");
        expect(await collectStream(result.body)).toEqual(encode("source content"));
      });

      it("copies a directory onto an existing directory: nests under <target>/<source name>, merging there, source entries overwrite same-named files", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/copy-onto-dir/source");
        await user.upload("/contract/copy-onto-dir/source/shared.txt", encode("source version"));
        await ensureDir(user, "/contract/copy-onto-dir/target");
        await user.upload(
          "/contract/copy-onto-dir/target/only-in-target.txt",
          encode("from target"),
        );
        // Seed the nested slot the copy lands in as if an earlier copy had already put it there,
        // so this exercises the merge (not just a fresh nested copy).
        await ensureDir(user, "/contract/copy-onto-dir/target/source");
        await user.upload(
          "/contract/copy-onto-dir/target/source/shared.txt",
          encode("old nested version"),
        );
        await user.upload(
          "/contract/copy-onto-dir/target/source/only-in-nested-target.txt",
          encode("kept"),
        );

        await user.copy("/contract/copy-onto-dir/source", "/contract/copy-onto-dir/target");

        // The target's own top level is untouched: the copy nests under target/source instead of
        // merging straight into target.
        const topNames = (await user.list("/contract/copy-onto-dir/target")).map(
          (entry) => entry.name,
        );
        expect(topNames).toContain("only-in-target.txt");
        expect(topNames).toContain("source");

        const nestedNames = (await user.list("/contract/copy-onto-dir/target/source")).map(
          (entry) => entry.name,
        );
        expect(nestedNames).toContain("only-in-nested-target.txt");
        const shared = await user.download("/contract/copy-onto-dir/target/source/shared.txt");
        expect(await collectStream(shared.body)).toEqual(encode("source version"));
      });

      it("moving a file onto an existing directory throws bad_request", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/move-file-onto-dir");
        await user.upload("/contract/move-file-onto-dir/source.txt", encode("source content"));
        await ensureDir(user, "/contract/move-file-onto-dir/target-dir");

        await expect(
          user.move(
            "/contract/move-file-onto-dir/source.txt",
            "/contract/move-file-onto-dir/target-dir",
          ),
        ).rejects.toMatchObject({ kind: "bad_request" });
        const names = (await user.list("/contract/move-file-onto-dir")).map((entry) => entry.name);
        expect(names).toContain("source.txt");
      });

      it("moving a directory onto an existing directory throws bad_request", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/move-dir-onto-dir/source");
        await ensureDir(user, "/contract/move-dir-onto-dir/target");

        await expect(
          user.move("/contract/move-dir-onto-dir/source", "/contract/move-dir-onto-dir/target"),
        ).rejects.toMatchObject({ kind: "bad_request" });
        const names = (await user.list("/contract/move-dir-onto-dir")).map((entry) => entry.name);
        expect(names).toContain("source");
        expect(names).toContain("target");
      });

      it("moving a directory onto an existing file throws server", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/move-dir-onto-file/source");
        await user.upload("/contract/move-dir-onto-file/target.txt", encode("target content"));

        await expect(
          user.move(
            "/contract/move-dir-onto-file/source",
            "/contract/move-dir-onto-file/target.txt",
          ),
        ).rejects.toMatchObject({ kind: "server" });
        const names = (await user.list("/contract/move-dir-onto-file")).map((entry) => entry.name);
        expect(names).toContain("source");
        const result = await user.download("/contract/move-dir-onto-file/target.txt");
        expect(await collectStream(result.body)).toEqual(encode("target content"));
      });

      // A seventh case, beyond the six from the spec this suite was built from: discovered while
      // building the API's own conflict guard (a rename to the same name has to be a safe no-op,
      // which meant checking what moving a file onto itself actually does), then verified
      // directly against the real container.
      it("moving a file onto itself throws bad_request, leaving its content untouched", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/move-onto-self");
        await user.upload("/contract/move-onto-self/a.txt", encode("original content"));

        await expect(
          user.move("/contract/move-onto-self/a.txt", "/contract/move-onto-self/a.txt"),
        ).rejects.toMatchObject({ kind: "bad_request" });

        const result = await user.download("/contract/move-onto-self/a.txt");
        expect(await collectStream(result.body)).toEqual(encode("original content"));
      });
    });

    describe("trash", () => {
      it("deleting a file lands under <trashPath>/<dir>/<name>/<ns>", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/trash/simple");
        await user.upload("/contract/trash/simple/note.txt", encode("trash me"));

        await user.deleteFile("/contract/trash/simple/note.txt");

        const parentEntries = await user.list("/contract/trash/simple");
        expect(parentEntries.map((entry) => entry.name)).not.toContain("note.txt");

        const leaves = await user.list(`${target.trashPath}/contract/trash/simple/note.txt`);
        expect(leaves).toHaveLength(1);
        expectFileEntry(leaves, leaves[0]?.name ?? "", "trash me");
        expect(leaves[0]?.name).toMatch(/^[0-9]{1,20}$/);
      });

      it("deleting a directory moves every nested file individually, including names with a space, Unicode, and a literal %20", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        const dir = "/contract/trash/dir-delete";
        await ensureDir(user, `${dir}/inner`);
        await user.upload(`${dir}/sp ace.txt`, encode("space"));
        await user.upload(`${dir}/inner/Å unicode.txt`, encode("unicode"));
        await user.upload(`${dir}/literal%20.txt`, encode("literal"));

        await user.deleteDir(dir);

        const parentEntries = await user.list("/contract/trash");
        expect(parentEntries.map((entry) => entry.name)).not.toContain("dir-delete");

        expect(await user.list(`${target.trashPath}${dir}/sp ace.txt`)).toHaveLength(1);
        expect(await user.list(`${target.trashPath}${dir}/inner/Å unicode.txt`)).toHaveLength(1);
        expect(await user.list(`${target.trashPath}${dir}/literal%20.txt`)).toHaveLength(1);
      });

      it("deleting a file already under the trash path is permanent", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/trash/permanent");
        await user.upload("/contract/trash/permanent/gone.txt", encode("permanent"));
        await user.deleteFile("/contract/trash/permanent/gone.txt");

        const trashDir = `${target.trashPath}/contract/trash/permanent/gone.txt`;
        const leaves = await user.list(trashDir);
        expect(leaves).toHaveLength(1);
        const leafName = leaves[0]?.name;
        expect(leafName).toBeDefined();

        await user.deleteFile(`${trashDir}/${leafName}`);

        expect(await user.list(trashDir)).toEqual([]);
      });
    });

    describe("setModifiedAt", () => {
      it("changes the mtime seen in a subsequent list, to the second", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/set-modified-at");
        const path = "/contract/set-modified-at/file.txt";
        await user.upload(path, encode("mtime target"));
        const newModifiedAt = new Date("2023-05-06T07:08:09.000Z");
        await user.setModifiedAt(path, newModifiedAt);
        const entries = await user.list("/contract/set-modified-at");
        const entry = entries.find((candidate) => candidate.name === "file.txt");
        expect(truncateToSecond(entry?.modifiedAt as Date)).toBe(truncateToSecond(newModifiedAt));
      });
    });

    describe("zip", () => {
      it("names entries after the full path with the leading slash stripped, with correct sizes", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        const stream = await user.zip(["/docs/readme.md", "/docs/report.pdf"]);
        const entries = parseZipCentralDirectory(await collectStream(stream));

        const readme = entries.find((entry) => entry.name === "docs/readme.md");
        expect(readme?.uncompressedSize).toBe(
          encode(SEED_FILES.alice?.["/docs/readme.md"] ?? "").length,
        );

        const report = entries.find((entry) => entry.name === "docs/report.pdf");
        expect(report?.uncompressedSize).toBe(
          encode(SEED_FILES.alice?.["/docs/report.pdf"] ?? "").length,
        );
      });
    });

    describe("profile", () => {
      it("returns profile fields with the right shape", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const profile = await target.client.user(token).profile();
        expect(typeof profile.email).toBe("string");
        expect(typeof profile.description).toBe("string");
        expect(typeof profile.allowApiKeyAuth).toBe("boolean");
        expect(Array.isArray(profile.publicKeys)).toBe(true);
      });
    });

    describe("shares", () => {
      it("creates a read share on a single directory and returns an id", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const { id } = await target.client.user(token).shares.create({
          name: "contract-shares-create",
          scope: "read",
          paths: ["/docs"],
        });
        expect(id.length).toBeGreaterThan(0);
      });

      it("get returns the created share with scope read and the given paths", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const shares = target.client.user(token).shares;
        const { id } = await shares.create({
          name: "contract-shares-get",
          scope: "read",
          paths: ["/docs"],
        });
        const share = await shares.get(id);
        expect(share.scope).toBe("read");
        expect(share.paths).toEqual(["/docs"]);
      });

      it("list includes a newly created share", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const shares = target.client.user(token).shares;
        const { id } = await shares.create({
          name: "contract-shares-list",
          scope: "read",
          paths: ["/docs"],
        });
        const list = await shares.list();
        expect(list.map((share) => share.id)).toContain(id);
      });

      it("update changes the name and keeps the password when password is omitted", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const shares = target.client.user(token).shares;
        const { id } = await shares.create({
          name: "contract-shares-update-original",
          scope: "read",
          paths: ["/docs"],
          password: "original-password",
        });
        await shares.update(id, {
          name: "contract-shares-update-renamed",
          scope: "read",
          paths: ["/docs"],
        });
        const share = await shares.get(id);
        expect(share.name).toBe("contract-shares-update-renamed");
        expect(share.hasPassword).toBe(true);
      });

      it("raw single-file shares support suffix ranges and directory listing does not consume quota", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        const { id } = await user.shares.create({
          name: "raw-single",
          scope: "read",
          paths: ["/docs/readme.md"],
        });
        const full = await target.client.publicShare(id).downloadFile();
        const text = await new Response(full.body).text();
        const suffix = await target.client
          .publicShare(id)
          .downloadFile({ rangeHeader: "bytes=-3" });
        expect(suffix.status).toBe(206);
        expect(await new Response(suffix.body).text()).toBe(text.slice(-3));
        await expect(target.client.publicShare(id).list()).rejects.toMatchObject({
          kind: "bad_request",
        });
        const dir = await user.shares.create({
          name: "list-quota",
          scope: "read",
          paths: ["/docs"],
          maxTokens: 1,
        });
        await target.client.publicShare(dir.id).list();
        await target.client.publicShare(dir.id).list();
        expect((await user.shares.get(dir.id)).usedTokens).toBe(0);
      });

      it("public share list through client.publicShare lists the seeded files", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const { id } = await target.client.user(token).shares.create({
          name: "contract-shares-public-list",
          scope: "read",
          paths: ["/docs"],
        });
        const entries = await target.client.publicShare(id).list();
        const names = entries.map((entry) => entry.name);
        expect(names).toContain("readme.md");
        expect(names).toContain("report.pdf");
      });

      it("public download returns the right bytes and honours a range", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const { id } = await target.client.user(token).shares.create({
          name: "contract-shares-public-download",
          scope: "read",
          paths: ["/docs"],
        });
        const content = encode(SEED_FILES.alice?.["/docs/readme.md"] ?? "");

        const full = await target.client.publicShare(id).download("/readme.md");
        expect(await collectStream(full.body)).toEqual(content);

        const ranged = await target.client
          .publicShare(id)
          .download("/readme.md", { range: { start: 0, end: 3 } });
        expect(ranged.status).toBe(206);
        expect(await collectStream(ranged.body)).toEqual(content.slice(0, 4));
      });

      it("public zip flattens entries relative to the shared directory and adds a / entry", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const { id } = await target.client.user(token).shares.create({
          name: "contract-shares-public-zip",
          scope: "read",
          paths: ["/docs"],
        });
        const stream = await target.client.publicShare(id).zip();
        const entries = parseZipCentralDirectory(await collectStream(stream));
        const names = entries.map((entry) => entry.name).sort();
        expect(names).toEqual(["/", "readme.md", "report.pdf"]);
      });

      it("a password-protected share rejects public access without the password and accepts it with the password", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const { id } = await target.client.user(token).shares.create({
          name: "contract-shares-password",
          scope: "read",
          paths: ["/docs"],
          password: "let-me-in",
        });
        await expect(target.client.publicShare(id).list()).rejects.toMatchObject({
          kind: "unauthorized",
        });
        const entries = await target.client.publicShare(id, "let-me-in").list();
        expect(entries.map((entry) => entry.name)).toContain("readme.md");
      });

      it("a write share on a fresh directory accepts an upload that then appears in the owner's listing", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        await ensureDir(user, "/contract/write-share-target");
        const { id } = await target.client.user(token).shares.create({
          name: "contract-shares-write",
          scope: "write",
          paths: ["/contract/write-share-target"],
        });
        for (const name of [
          "uploaded-via-share.txt",
          "literal%20.txt",
          "literal%2F.txt",
          "文 space.txt",
        ]) {
          await target.client.publicShare(id).upload(name, encode(name));
          expect(
            await new Response(
              (await user.download(`/contract/write-share-target/${name}`)).body,
            ).text(),
          ).toBe(name);
        }
        const entries = await user.list("/contract/write-share-target");
        expect(entries.map((entry) => entry.name)).toContain("uploaded-via-share.txt");
      });

      it("remove deletes the share and get then throws not_found", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const shares = target.client.user(token).shares;
        const { id } = await shares.create({
          name: "contract-shares-remove",
          scope: "read",
          paths: ["/docs"],
        });
        await shares.remove(id);
        await expect(shares.get(id)).rejects.toMatchObject({ kind: "not_found" });
      });
    });

    describe("permissions", () => {
      it("bob's mkdir at the root throws forbidden", async () => {
        const bob = findUser(target.users, "bob");
        const token = await loginAs(target.client, bob);
        await expect(
          target.client.user(token).mkdir("/newdir-permissions-test"),
        ).rejects.toMatchObject({ kind: "forbidden" });
      });

      it("bob can mkdir and upload inside /inbox", async () => {
        const bob = findUser(target.users, "bob");
        const token = await loginAs(target.client, bob);
        const user = target.client.user(token);
        await user.mkdir("/inbox/contract-permissions");
        await user.upload("/inbox/contract-permissions/file.txt", encode("bob's upload"));
        const entries = await user.list("/inbox/contract-permissions");
        expect(entries.map((entry) => entry.name)).toContain("file.txt");
      });

      it("bob's upload to /public throws forbidden", async () => {
        const bob = findUser(target.users, "bob");
        const token = await loginAs(target.client, bob);
        await expect(
          target.client.user(token).upload("/public/contract-forbidden.txt", encode("nope")),
        ).rejects.toMatchObject({ kind: "forbidden" });
      });

      it("bob's deleteFile on /public/notes.txt throws forbidden", async () => {
        const bob = findUser(target.users, "bob");
        const token = await loginAs(target.client, bob);
        await expect(
          target.client.user(token).deleteFile("/public/notes.txt"),
        ).rejects.toMatchObject({ kind: "forbidden" });
      });

      it("alice's list outside her home never returns entries that are not hers", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const user = target.client.user(token);
        const root = await user.list("/");
        try {
          const outside = await user.list("/../etc");
          expect(outside.map((entry) => entry.name).sort()).toEqual(
            root.map((entry) => entry.name).sort(),
          );
        } catch (error) {
          expect(error).toBeInstanceOf(SftpgoError);
          expect(["not_found", "bad_request"]).toContain((error as SftpgoError).kind);
        }
      });
    });

    // The literal example path from the spec this suite was built from,
    // "/a b", is not actually rejected by assertValidPath: SFTPGo virtual
    // paths may legitimately contain spaces (its own OpenAPI description
    // for the "path" query parameter says as much, and they only need URL
    // encoding, which buildUrl already does via URLSearchParams). Using it
    // here would test something the client correctly does NOT reject.
    // A NUL byte is used instead as the second genuinely-invalid path,
    // matching the rule assertValidPath actually enforces.
    describe("client-side path validation", () => {
      it("list with a relative path throws bad_request without a network call", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const before = target.fetchCallCount?.();
        await expect(target.client.user(token).list("relative")).rejects.toMatchObject({
          kind: "bad_request",
        });
        if (before !== undefined) {
          expect(target.fetchCallCount?.()).toBe(before);
        }
      });

      it("list with a NUL byte in the path throws bad_request without a network call", async () => {
        const alice = findUser(target.users, "alice");
        const token = await loginAs(target.client, alice);
        const before = target.fetchCallCount?.();
        await expect(target.client.user(token).list("/a\0b")).rejects.toMatchObject({
          kind: "bad_request",
        });
        if (before !== undefined) {
          expect(target.fetchCallCount?.()).toBe(before);
        }
      });
    });
  });
}
