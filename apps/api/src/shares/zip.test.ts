import { ApiError, PublicShare } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import * as yauzl from "yauzl";
import { cookieFrom, patchStorage, sharesHarness } from "./test-fixtures/index.ts";

const pub = (id: string) => `/api/v1/public/shares/${id}`;
type Harness = ReturnType<typeof sharesHarness>;

/** Every file in a zip, by entry name, with its text. */
async function unzip(response: Response): Promise<Record<string, string>> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, file) =>
      error ? reject(error) : resolve(file),
    ),
  );
  const files: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith("/")) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          files[entry.fileName] = Buffer.concat(chunks).toString("utf8");
          zip.readEntry();
        });
      });
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return files;
}
async function used(h: Harness, id: string) {
  return PublicShare.parse(await (await h.request(pub(id))).json()).usedDownloads;
}
async function error(response: Response) {
  return ApiError.parse(await response.json()).error;
}

describe("archive downloads of a public share", () => {
  it("zips a folder share as one download, and answers HEAD without spending one", async () => {
    const h = sharesHarness({ trashPath: "/.trash" });
    h.write("/folder/a.txt", "alpha");
    h.write("/folder/sub/b.txt", "bravo");
    h.write("/.trash/old.txt", "gone");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { name: "Holiday", paths: ["/folder"] });
    const head = await h.request(`${pub(id)}/archive`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/zip");
    expect(await head.text()).toBe("");
    expect(await used(h, id)).toBe(0);

    const zip = await h.request(`${pub(id)}/archive`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toContain("Holiday.zip");
    expect(zip.headers.get("cache-control")).toBe("no-store");
    expect(await unzip(zip)).toEqual({ "folder/a.txt": "alpha", "folder/sub/b.txt": "bravo" });
    expect(await used(h, id)).toBe(1);
  });

  it("zips every path of an archive share under its own name", async () => {
    const h = sharesHarness();
    h.write("/photos/x.jpg", "x");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/a.docx", "/report.txt", "/photos"] });
    expect(await unzip(await h.request(`${pub(id)}/archive`))).toEqual({
      "a.docx": "alice data",
      "report.txt": "alice report",
      "photos/x.jpg": "x",
    });
  });

  it("is refused with the same limit and password rules as a download", async () => {
    const h = sharesHarness();
    h.write("/folder/a.txt", "alpha");
    const cookie = await h.login();
    const limited = await h.create(cookie, { paths: ["/folder"], maxDownloads: 1 });
    expect((await h.request(`${pub(limited.id)}/archive`)).status).toBe(200);
    const spent = await h.request(`${pub(limited.id)}/archive`);
    expect(spent.status).toBe(403);
    expect((await error(spent)).details).toEqual({ reason: "limit" });
    const locked = await h.create(cookie, { paths: ["/folder"], password: "secret" });
    expect((await h.request(`${pub(locked.id)}/archive`)).status).toBe(401);
    expect((await h.request(`${pub(locked.id)}/archive`, { method: "HEAD" })).status).toBe(401);
    const envelope = cookieFrom(
      await h.request(`${pub(locked.id)}/credentials`, {
        method: "POST",
        body: { password: "secret" },
      }),
    );
    expect(await unzip(await h.request(`${pub(locked.id)}/archive`, { cookie: envelope }))).toEqual(
      { "folder/a.txt": "alpha" },
    );
  });

  it("never carries the Trash or a backup folder into an archive", async () => {
    const h = sharesHarness({ trashPath: "/.trash" });
    h.write("/.trash/old.txt", "gone");
    h.write("/folder/.fdrive-backups/b", "backup");
    h.write("/clean/a.txt", "alpha");
    const cookie = await h.login();
    // The whole home holds the Trash: listing hides it, an archive cannot.
    const home = await h.create(cookie, { paths: ["/"] });
    const refused = await h.request(`${pub(home.id)}/archive`);
    expect(refused.status).toBe(403);
    expect((await error(refused)).message).toContain("Trash");
    // A backup folder anywhere inside is refused by the owner's storage.
    const folder = await h.create(cookie, { paths: ["/folder"] });
    expect((await h.request(`${pub(folder.id)}/archive`)).status).toBe(403);
    expect(await used(h, home.id)).toBe(0);
    expect(await used(h, folder.id)).toBe(0);
    // A folder beside the Trash is unaffected.
    const clean = await h.create(cookie, { paths: ["/clean"] });
    expect(await unzip(await h.request(`${pub(clean.id)}/archive`))).toEqual({
      "clean/a.txt": "alpha",
    });
  });

  it("refuses a carried-over share whose paths are hidden now or would collide", async () => {
    const h = sharesHarness({ trashPath: "/.trash" });
    h.write("/.trash/old.txt", "gone");
    h.write("/one/report.txt", "one");
    h.write("/two/report.txt", "two");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/one"] });
    const row = await h.shares.get(id);
    if (row === null) throw new Error("missing row");
    // Rows written before these rules, as the SFTPGo migration carried them over.
    await h.shares.updateOwned(row.identityId, id, {
      ...row,
      paths: ["/one/report.txt", "/two/report.txt"],
      at: h.clock(),
    });
    const collides = await h.request(`${pub(id)}/archive`);
    expect(collides.status).toBe(400);
    expect((await error(collides)).message).toContain("same name");
    await h.shares.updateOwned(row.identityId, id, {
      ...row,
      paths: ["/.trash/old.txt", "/one"],
      at: h.clock(),
    });
    expect((await h.request(`${pub(id)}/archive`)).status).toBe(404);
    expect(await used(h, id)).toBe(0);
  });

  it("is unsupported on storage without a zip", async () => {
    const h = sharesHarness({ local: patchStorage(({ zip: _zip, ...storage }) => storage) });
    h.write("/folder/a.txt", "alpha");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/folder"] });
    const refused = await h.request(`${pub(id)}/archive`);
    expect(refused.status).toBe(400);
    expect(await error(refused)).toMatchObject({
      kind: "unsupported",
      details: { capability: "zip" },
    });
  });

  it("holds each share to its concurrent archives, and frees a slot when one ends", async () => {
    const h = sharesHarness({ zipLimits: { perShare: 1 } });
    h.write("/folder/a.txt", "alpha");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/folder"] });
    const other = await h.create(cookie, { paths: ["/folder"] });
    const first = await h.request(`${pub(id)}/archive`);
    expect(first.status).toBe(200);
    const busy = await h.request(`${pub(id)}/archive`);
    expect(busy.status).toBe(429);
    expect(await used(h, id)).toBe(1);
    // Another link to the same folder has its own slot.
    expect(await unzip(await h.request(`${pub(other.id)}/archive`))).toEqual({
      "folder/a.txt": "alpha",
    });
    await first.body?.cancel();
    expect(await unzip(await h.request(`${pub(id)}/archive`))).toEqual({
      "folder/a.txt": "alpha",
    });
    expect((await h.request(`${pub(id)}/archive`)).status).toBe(200);
  });

  it("cuts an archive off past its byte ceiling or its time", async () => {
    const big = sharesHarness({ zipLimits: { maxBytes: 64 } });
    big.write("/folder/a.txt", "x".repeat(4096));
    const owner = await big.login();
    const large = await big.create(owner, { paths: ["/folder"] });
    const cut = await big.request(`${pub(large.id)}/archive`);
    expect(cut.status).toBe(200);
    await expect(cut.arrayBuffer()).rejects.toThrow("maximum of 64 bytes");
    // The slot came back: both of the share's slots are free again.
    expect((await big.request(`${pub(large.id)}/archive`)).status).toBe(200);
    expect((await big.request(`${pub(large.id)}/archive`)).status).toBe(200);

    const slow = sharesHarness({ zipLimits: { timeoutMs: 60_000 } });
    slow.write("/folder/a.txt", "alpha");
    const { id } = await slow.create(await slow.login(), { paths: ["/folder"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const late = await slow.request(`${pub(id)}/archive`);
      expect(late.status).toBe(200);
      vi.advanceTimersByTime(60_000);
      await expect(late.arrayBuffer()).rejects.toThrow("took too long");
    } finally {
      vi.useRealTimers();
    }
  });
});
