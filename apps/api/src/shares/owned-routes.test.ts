import {
  ApiError,
  ManagedShare,
  PublicShare,
  ShareEntriesResponse,
  SharesResponse,
} from "@fdrive/contracts";
import { StorageError } from "@fdrive/core";
import { createSftpgoModule } from "@fdrive/sftpgo";
import { createMemoryStorage } from "@fdrive/testkit";
import { describe, expect, it, vi } from "vitest";
import { cookieFrom } from "../accounts/test-fixtures/index.ts";
import { sharesHarness } from "./test-fixtures/index.ts";

const FILES = {
  "/a.docx": "alice data",
  "/folder/a.txt": "content",
  "/inbox/.keep": "",
  "/.trash/old.txt": "gone",
  "/.fdrive-backups/b": "backup",
};

/**
 * The harness's SFTPGo login, with its module declaring owned shares and
 * handing out an in-memory storage: the identity is a real login, the fake
 * SFTPGo server only ever sees the sign-in, and every share byte comes
 * from the memory storage.
 */
function ownedHarness() {
  const memory = createMemoryStorage(FILES);
  let h = sharesHarness();
  h = sharesHarness({
    trashPath: "/.trash",
    modules: {
      sftpgo: {
        ...createSftpgoModule({ clientFor: () => h.client }),
        shares: "owned",
        createStorage: () => memory,
      },
    },
  });
  return { h, memory };
}
const pub = (id: string) => `/api/v1/public/shares/${id}`;
async function error(response: Response) {
  return ApiError.parse(await response.json()).error;
}
async function metadata(h: ReturnType<typeof sharesHarness>, id: string, cookie?: string) {
  return PublicShare.parse(
    await (await h.request(pub(id), cookie === undefined ? {} : { cookie })).json(),
  );
}

describe("owned shares through the API", () => {
  it("manages links in the database only, never through the storage's share API", async () => {
    const { h } = ownedHarness();
    const cookie = await h.login();
    const user = vi.spyOn(h.client, "user");
    const publicShare = vi.spyOn(h.client, "publicShare");
    const created = await h.create(cookie, { description: "Quarterly numbers" });
    const share = ManagedShare.parse(
      await (await h.request(`/api/v1/shares/${created.id}`, { cookie })).json(),
    );
    expect(share).toMatchObject({
      name: "Document",
      description: "Quarterly numbers",
      paths: ["/a.docx"],
      scope: "read",
      hasPassword: false,
      usedDownloads: 0,
      maxDownloads: 0,
      presentation: "auto",
    });
    expect((await h.shares.get(created.id))?.sftpgoShareId).toBeNull();
    expect(
      SharesResponse.parse(await (await h.request("/api/v1/shares", { cookie })).json()).items,
    ).toEqual([share]);
    const patched = await h.request(`/api/v1/shares/${created.id}`, {
      cookie,
      method: "PATCH",
      body: { name: "Renamed", presentation: "list", maxDownloads: 3 },
    });
    expect(patched.status).toBe(200);
    expect(ManagedShare.parse(await patched.json())).toMatchObject({
      name: "Renamed",
      presentation: "list",
      maxDownloads: 3,
      description: "Quarterly numbers",
    });
    expect(
      (await h.request(`/api/v1/shares/${created.id}`, { cookie, method: "DELETE" })).status,
    ).toBe(200);
    expect(await h.shares.get(created.id)).toBeNull();
    expect(
      SharesResponse.parse(await (await h.request("/api/v1/shares", { cookie })).json()).items,
    ).toEqual([]);
    expect(user).not.toHaveBeenCalled();
    expect(publicShare).not.toHaveBeenCalled();
  });

  it("refuses the Trash and backup folders, missing paths, and a file for an upload share", async () => {
    const { h } = ownedHarness();
    const cookie = await h.login();
    const attempt = (body: Record<string, unknown>) =>
      h.request("/api/v1/shares", {
        cookie,
        method: "POST",
        body: { name: "Bad", scope: "read", ...body },
      });
    for (const paths of [
      ["/.trash"],
      ["/.trash/old.txt"],
      ["/.fdrive-backups/b"],
      ["/a.docx", "/.trash"],
    ])
      expect((await attempt({ paths })).status, paths.join()).toBe(403);
    expect((await attempt({ paths: ["/missing.txt"] })).status).toBe(404);
    expect((await attempt({ paths: ["/a.docx"], scope: "write" })).status).toBe(400);
    const { id } = await h.create(cookie);
    expect(
      (
        await h.request(`/api/v1/shares/${id}`, {
          cookie,
          method: "PATCH",
          body: { paths: ["/.trash/old.txt"] },
        })
      ).status,
    ).toBe(403);
    expect((await h.shares.get(id))?.paths).toEqual(["/a.docx"]);
  });

  it("serves a single file with HEAD, ranges, a 416, and the download limit", async () => {
    const { h } = ownedHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { maxDownloads: 3 });
    const path = pub(id);
    expect(await metadata(h, id)).toMatchObject({
      layout: "single-file",
      fileName: "a.docx",
      usedDownloads: 0,
      maxDownloads: 3,
      unavailableReason: null,
    });
    const head = await h.request(`${path}/download`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("content-disposition")).toContain("a.docx");
    expect(await head.text()).toBe("");
    expect((await metadata(h, id)).usedDownloads).toBe(0);

    const full = await h.request(`${path}/download`);
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("alice data");
    expect((await metadata(h, id)).usedDownloads).toBe(1);

    const tail = await h.request(`${path}/download`, { headers: { range: "bytes=-4" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 6-9/10");
    expect(await tail.text()).toBe("data");

    // A range past the end is refused before anything is spent.
    const beyond = await h.request(`${path}/download`, { headers: { range: "bytes=20-" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */10");
    expect((await metadata(h, id)).usedDownloads).toBe(2);

    const multi = await h.request(`${path}/download`, { headers: { range: "bytes=0-1,6-7" } });
    expect(multi.status).toBe(200);
    expect(await multi.text()).toBe("alice data");
    expect((await metadata(h, id)).usedDownloads).toBe(3);

    const refused = await h.request(`${path}/download`);
    expect(refused.status).toBe(403);
    expect((await error(refused)).details).toEqual({ reason: "limit" });
    expect((await metadata(h, id)).unavailableReason).toBe("limit");
    expect((await h.request(`${path}/download?path=/x`)).status).toBe(403);
  });

  it("lists a directory share without the hidden folders and serves its children", async () => {
    const { h } = ownedHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/"] });
    const path = pub(id);
    expect((await metadata(h, id)).layout).toBe("directory");
    const names = ShareEntriesResponse.parse(
      await (await h.request(`${path}/entries`)).json(),
    ).items.map((entry) => entry.name);
    expect(names).toContain("a.docx");
    expect(names).toContain("folder");
    expect(names).not.toContain(".trash");
    expect(names).not.toContain(".fdrive-backups");
    expect(
      ShareEntriesResponse.parse(
        await (await h.request(`${path}/entries?path=/folder`)).json(),
      ).items.map((entry) => entry.name),
    ).toEqual(["a.txt"]);
    expect(await (await h.request(`${path}/download?path=/folder/a.txt`)).text()).toBe("content");
    for (const hidden of ["/.trash/old.txt", "/.fdrive-backups/b", "/nope"])
      expect((await h.request(`${path}/download?path=${hidden}`)).status, hidden).toBe(404);
    expect((await h.request(`${path}/entries?path=/.trash`)).status).toBe(404);
  });

  it("checks the password once when the cookie is issued and its marker on every request", async () => {
    const { h } = ownedHarness();
    const cookie = await h.login();
    const publicShare = vi.spyOn(h.client, "publicShare");
    const { id } = await h.create(cookie, { password: "secret" });
    const path = pub(id);
    expect(await metadata(h, id)).toMatchObject({
      name: "",
      hasPassword: true,
      credentialPresent: false,
      layout: "directory",
      fileName: null,
    });
    const anonymous = await h.request(`${path}/download`);
    expect(anonymous.status).toBe(401);
    expect((await error(anonymous)).details).toEqual({ reason: "password" });
    const wrong = await h.request(`${path}/credentials`, {
      method: "POST",
      body: { password: "nope" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const right = await h.request(`${path}/credentials`, {
      method: "POST",
      body: { password: "secret" },
    });
    expect(right.status).toBe(200);
    const envelope = cookieFrom(right);
    expect(await metadata(h, id, envelope)).toMatchObject({
      name: "Document",
      credentialPresent: true,
      layout: "single-file",
      fileName: "a.docx",
    });
    expect((await h.request(`${path}/download`, { cookie: envelope })).status).toBe(200);

    // A new password invalidates every cookie issued for the old one.
    expect(
      (
        await h.request(`/api/v1/shares/${id}`, {
          cookie,
          method: "PATCH",
          body: { password: "other" },
        })
      ).status,
    ).toBe(200);
    expect((await h.request(`${path}/download`, { cookie: envelope })).status).toBe(401);
    expect((await metadata(h, id, envelope)).credentialPresent).toBe(false);
    const renewed = cookieFrom(
      await h.request(`${path}/credentials`, { method: "POST", body: { password: "other" } }),
    );
    expect((await h.request(`${path}/download`, { cookie: renewed })).status).toBe(200);

    // Removing the password opens the link to everyone.
    expect(
      (await h.request(`/api/v1/shares/${id}`, { cookie, method: "PATCH", body: { password: "" } }))
        .status,
    ).toBe(200);
    expect((await metadata(h, id)).hasPassword).toBe(false);
    expect((await h.request(`${path}/download`)).status).toBe(200);
    expect(publicShare).not.toHaveBeenCalled();
  });

  it("expires", async () => {
    const { h } = ownedHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, {
      expiresAt: new Date(h.clock().getTime() + 1000).toISOString(),
    });
    expect((await metadata(h, id)).unavailableReason).toBeNull();
    h.now.value = new Date(h.clock().getTime() + 2000);
    expect((await metadata(h, id)).unavailableReason).toBe("expired");
    const refused = await h.request(`${pub(id)}/download`);
    expect(refused.status).toBe(403);
    expect((await error(refused)).details).toEqual({ reason: "expired" });
  });

  it("accepts uploads into an upload share, checked eagerly, and nothing else", async () => {
    const { h, memory } = ownedHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, {
      paths: ["/inbox"],
      scope: "write",
      password: "secret",
    });
    const path = pub(id);
    expect(await metadata(h, id)).toMatchObject({ scope: "write", hasPassword: true, name: "" });
    expect(
      (await h.request(`${path}/credentials`, { method: "POST", body: { password: "nope" } }))
        .status,
    ).toBe(401);
    const envelope = cookieFrom(
      await h.request(`${path}/credentials`, { method: "POST", body: { password: "secret" } }),
    );
    // An owned write share reveals itself once the password checked out.
    expect(await metadata(h, id, envelope)).toMatchObject({
      name: "Document",
      layout: "directory",
      credentialPresent: true,
    });
    expect(
      (
        await h.request(`${path}/upload?path=/new.txt`, {
          method: "PUT",
          raw: "upload",
          cookie: envelope,
        })
      ).status,
    ).toBe(200);
    expect(memory.dump()["/inbox/new.txt"]).toBe("upload");
    expect((await metadata(h, id, envelope)).usedDownloads).toBe(1);
    expect(
      (await h.request(`${path}/upload?path=/other.txt`, { method: "PUT", raw: "x" })).status,
    ).toBe(401);
    for (const suffix of ["entries", "download", "archive"])
      expect((await h.request(`${path}/${suffix}`, { cookie: envelope })).status, suffix).toBe(403);
    const read = await h.create(cookie);
    expect(
      (await h.request(`${pub(read.id)}/upload?path=/x.txt`, { method: "PUT", raw: "x" })).status,
    ).toBe(403);
  });

  it("has no archive download yet", async () => {
    const { h } = ownedHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/a.docx", "/folder/a.txt"] });
    expect((await metadata(h, id)).layout).toBe("archive");
    expect((await h.request(`${pub(id)}/archive`)).status).toBe(400);
    expect((await h.request(`${pub(id)}/entries`)).status).toBe(400);
    expect((await h.request(`${pub(id)}/download`)).status).toBe(400);
  });

  it("shows a storage failure as unavailable, never as a password error", async () => {
    const { h, memory } = ownedHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { password: "secret" });
    const envelope = cookieFrom(
      await h.request(`${pub(id)}/credentials`, { method: "POST", body: { password: "secret" } }),
    );
    vi.spyOn(memory, "download").mockRejectedValueOnce(
      new StorageError("forbidden", "AccessDenied: the owner's key was refused"),
    );
    const failed = await h.request(`${pub(id)}/download`, { cookie: envelope });
    expect(failed.status).toBe(502);
    const body = await failed.text();
    expect(ApiError.parse(JSON.parse(body)).error.kind).toBe("upstream_unavailable");
    expect(body).not.toContain("AccessDenied");
    expect((await metadata(h, id, envelope)).usedDownloads).toBe(0);
  });
});
