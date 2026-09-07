import { ArchiveEntriesResponse } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { sharesHarness } from "./test-fixtures/index.ts";

function publicBase(id: string): string {
  return `/api/v1/public/shares/${id}`;
}

async function buildZipBuffer(build: (zipfile: ZipFile) => void): Promise<Buffer> {
  const zipfile = new ZipFile();
  build(zipfile);
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on("end", resolve);
    zipfile.outputStream.on("error", reject);
  });
  zipfile.end();
  await done;
  return Buffer.concat(chunks);
}

async function threeEntryZip(): Promise<Buffer> {
  return buildZipBuffer((zipfile) => {
    zipfile.addBuffer(Buffer.from("one"), "a.txt");
    zipfile.addBuffer(Buffer.from("two"), "b.txt");
    zipfile.addBuffer(Buffer.from("three"), "dir/c.txt");
  });
}

describe("GET /api/v1/public/shares/:id/archive-entries", () => {
  it("peeks a zip through a directory share", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    await user.mkdir("/folder");
    await user.upload("/folder/docs.zip", await threeEntryZip());
    const { id } = await h.create(cookie, { paths: ["/folder"] });
    const response = await h.request(`${publicBase(id)}/archive-entries?path=/docs.zip`);
    expect(response.status).toBe(200);
    const body = ArchiveEntriesResponse.parse(await response.json());
    expect(body.format).toBe("zip");
    expect(body.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt", "dir/c.txt"]);
    expect(body.truncated).toBe(false);
  });

  it("peeks a zip through a single-file share", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    await user.upload("/docs.zip", await threeEntryZip());
    const { id } = await h.create(cookie, { paths: ["/docs.zip"] });
    const response = await h.request(`${publicBase(id)}/archive-entries`);
    expect(response.status).toBe(200);
    const body = ArchiveEntriesResponse.parse(await response.json());
    expect(body.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt", "dir/c.txt"]);
  });

  it("rejects a share with a download limit", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    await user.upload("/docs.zip", await threeEntryZip());
    const { id } = await h.create(cookie, { paths: ["/docs.zip"], maxDownloads: 5 });
    const response = await h.request(`${publicBase(id)}/archive-entries`);
    expect(response.status).toBe(403);
  });

  it("rejects a multi-path (archive-of-many) share", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/a.docx", "/report.txt"] });
    const response = await h.request(`${publicBase(id)}/archive-entries`);
    expect(response.status).toBe(403);
  });

  it("rejects the wrong password like every other public share route", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    await user.upload("/docs.zip", await threeEntryZip());
    const { id } = await h.create(cookie, { paths: ["/docs.zip"], password: "secret" });
    const response = await h.request(`${publicBase(id)}/archive-entries`);
    expect(response.status).toBe(401);
  });

  it("rejects an unsupported extension as bad_request", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    await user.upload("/notes.txt", Buffer.from("hello"));
    const { id } = await h.create(cookie, { paths: ["/notes.txt"] });
    const response = await h.request(`${publicBase(id)}/archive-entries`);
    expect(response.status).toBe(400);
  });

  it("rejects a corrupt archive as bad_request", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    await user.upload("/bad.zip", Buffer.from("not a zip at all"));
    const { id } = await h.create(cookie, { paths: ["/bad.zip"] });
    const response = await h.request(`${publicBase(id)}/archive-entries`);
    expect(response.status).toBe(400);
  });

  it("returns truncated once the entry bound is hit", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    const zip = await buildZipBuffer((zipfile) => {
      for (let i = 0; i < 5001; i++) {
        zipfile.addBuffer(Buffer.from("x"), `file-${i}.txt`);
      }
    });
    await user.upload("/big.zip", zip);
    const { id } = await h.create(cookie, { paths: ["/big.zip"] });
    const response = await h.request(`${publicBase(id)}/archive-entries`);
    expect(response.status).toBe(200);
    const body = ArchiveEntriesResponse.parse(await response.json());
    expect(body.entries).toHaveLength(5000);
    expect(body.truncated).toBe(true);
  });
});
