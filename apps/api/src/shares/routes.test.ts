import {
  ApiError,
  ManagedShare,
  PublicShare,
  ShareEntriesResponse,
  SharesResponse,
} from "@fdrive/contracts";
import { type ProviderModule, StorageError } from "@fdrive/core";
import type { IndexedFile, IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { ScopeResolver } from "../scoping/resolver.ts";
import type { ThumbFileReader } from "../thumbs/serve.ts";
import { capByteStream, contentLengthExceeds } from "./routes.ts";
import { cookieFrom, patchStorage, sharesHarness } from "./test-fixtures/index.ts";

const base = "/api/v1/shares";
const pub = (id: string) => `/api/v1/public/shares/${id}`;
type Harness = ReturnType<typeof sharesHarness>;
async function error(response: Response) {
  return ApiError.parse(await response.json()).error;
}
async function metadata(h: Harness, id: string, cookie?: string) {
  return PublicShare.parse(
    await (await h.request(pub(id), cookie === undefined ? {} : { cookie })).json(),
  );
}
async function names(response: Response) {
  return ShareEntriesResponse.parse(await response.json()).items.map((entry) => entry.name);
}
describe("share management", () => {
  it("manages only the session identity's shares, in the database, and revokes them", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const bob = await h.login("bob");
    const share = await h.create(cookie, { password: "secret", description: "Quarterly" });
    const path = `${base}/${share.id}`;
    expect((await h.request(path)).status).toBe(401);
    expect((await h.request(path, { cookie: bob })).status).toBe(404);
    expect(
      (await h.request(path, { cookie, headers: { authorization: "Bearer nope" } })).status,
    ).toBe(403);
    const get = ManagedShare.parse(await (await h.request(path, { cookie })).json());
    expect(get).toMatchObject({
      publicPath: `/s/${share.id}`,
      name: "Document",
      description: "Quarterly",
      paths: ["/a.docx"],
      scope: "read",
      hasPassword: true,
      usedDownloads: 0,
      maxDownloads: 0,
      presentation: "auto",
    });
    expect(SharesResponse.parse(await (await h.request(base, { cookie })).json()).items).toEqual([
      get,
    ]);
    expect(
      SharesResponse.parse(await (await h.request(base, { cookie: bob })).json()).items,
    ).toEqual([]);
    let response = await h.request(path, {
      cookie,
      method: "PATCH",
      body: { name: "Renamed", presentation: "gallery", maxDownloads: 3 },
    });
    expect(ManagedShare.parse(await response.json())).toMatchObject({
      name: "Renamed",
      presentation: "gallery",
      maxDownloads: 3,
      hasPassword: true,
      description: "Quarterly",
    });
    response = await h.request(path, { cookie, method: "PATCH", body: { name: "Again" } });
    expect(ManagedShare.parse(await response.json()).presentation).toBe("gallery");
    response = await h.request(path, { cookie, method: "PATCH", body: { password: "" } });
    expect(ManagedShare.parse(await response.json()).hasPassword).toBe(false);
    response = await h.request(path, { cookie, method: "PATCH", body: { password: "new" } });
    expect(ManagedShare.parse(await response.json()).hasPassword).toBe(true);
    expect(
      (await h.request(path, { cookie, method: "PATCH", body: { allowFrom: [] } })).status,
    ).toBe(400);
    expect((await h.request(path, { cookie: bob, method: "DELETE" })).status).toBe(404);
    expect((await h.request(path, { cookie, method: "DELETE" })).status).toBe(200);
    expect(await h.shares.get(share.id)).toBeNull();
    expect((await h.request(pub(share.id))).status).toBe(404);
    expect((await h.request(path, { cookie, method: "PATCH", body: { name: "x" } })).status).toBe(
      404,
    );
    // Revoking a link never touches what it pointed at.
    expect(h.read("/a.docx")).toBe("alice data");
  });

  it("refuses the Trash and backup folders, missing paths, colliding names and a file to upload into", async () => {
    const h = sharesHarness({ trashPath: "/.trash" });
    h.write("/.trash/old.txt", "gone");
    h.write("/.fdrive-backups/b", "backup");
    h.write("/.fdrive-desktop/mac/trash/old.txt", "the Mac's Trash");
    h.write("/one/report.txt", "one");
    h.write("/two/Report.txt", "two");
    const cookie = await h.login();
    const attempt = (body: Record<string, unknown>) =>
      h.request(base, { cookie, method: "POST", body: { name: "Bad", scope: "read", ...body } });
    for (const paths of [
      ["/.trash"],
      ["/.trash/old.txt"],
      ["/.fdrive-backups/b"],
      ["/.fdrive-desktop/mac/trash/old.txt"],
      ["/a.docx", "/.trash"],
    ])
      expect((await attempt({ paths })).status, paths.join()).toBe(403);
    expect((await attempt({ paths: ["/missing.txt"] })).status).toBe(404);
    // A name segment over 255 bytes fits the request schema but no file system.
    expect((await attempt({ paths: [`/${"a".repeat(300)}`] })).status).toBe(400);
    expect((await attempt({ paths: ["/a.docx"], scope: "write" })).status).toBe(400);
    for (const paths of [
      ["/one/report.txt", "/two/Report.txt"],
      ["/one", "/one/report.txt"],
      ["/", "/a.docx"],
    ]) {
      const refused = await attempt({ paths });
      expect(refused.status, paths.join()).toBe(400);
      expect((await error(refused)).message).toContain("same name");
    }
    const { id } = await h.create(cookie);
    expect(
      (
        await h.request(`${base}/${id}`, {
          cookie,
          method: "PATCH",
          body: { paths: ["/.trash/old.txt"] },
        })
      ).status,
    ).toBe(403);
    expect((await h.shares.get(id))?.paths).toEqual(["/a.docx"]);
  });

  it("keeps folders shared with the owner out of every link, as their owner's to share", async () => {
    const h = sharesHarness({
      grants: { alice: [{ owner: "bob", path: "/team", writable: true }] },
    });
    h.write("/team/plan.txt", "bob's plan", "bob");
    const cookie = await h.login();
    const home = await h.create(cookie, { paths: ["/"] });
    const row = await h.shares.get(home.id);
    if (row === null) throw new Error("missing row");
    // The grant is real: alice's own files show bob's folder.
    const own = await h.storageFactory(row.identityId);
    expect((await own.list("/")).map((entry) => entry.name)).toContain("Shared with me");
    expect((await own.list("/Shared with me/team")).map((entry) => entry.name)).toEqual([
      "plan.txt",
    ]);
    const through = (path: string) => encodeURIComponent(path);
    expect((await names(await h.request(`${pub(home.id)}/entries`))).sort()).toEqual([
      "a.docx",
      "report.txt",
    ]);
    expect(
      (await h.request(`${pub(home.id)}/entries?path=${through("/Shared with me")}`)).status,
    ).toBe(404);
    expect(
      (await h.request(`${pub(home.id)}/download?path=${through("/Shared with me/team/plan.txt")}`))
        .status,
    ).toBe(404);
    expect((await h.request(`${pub(home.id)}/archive`)).status).toBe(403);
    for (const paths of [
      ["/Shared with me"],
      ["/Shared with me/team"],
      ["/Shared with me/team/plan.txt"],
      ["/a.docx", "/Shared with me/team"],
    ]) {
      const refused = await h.request(base, {
        cookie,
        method: "POST",
        body: { name: "Theirs", scope: "read", paths },
      });
      expect(refused.status, paths.join()).toBe(403);
    }
    const file = await h.create(cookie);
    expect(
      (
        await h.request(`${base}/${file.id}`, {
          cookie,
          method: "PATCH",
          body: { paths: ["/Shared with me/team"], scope: "write" },
        })
      ).status,
    ).toBe(403);
    // Bob shares his own folder as usual.
    const bob = await h.login("bob");
    const team = await h.create(bob, { paths: ["/team"] });
    expect(await (await h.request(`${pub(team.id)}/download?path=/plan.txt`)).text()).toBe(
      "bob's plan",
    );
  });

  it("refuses download limits past the counter column on create and update", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const overLimit = 2_147_483_648;
    const created = await h.create(cookie, { maxDownloads: 2_147_483_647 });
    const path = `${base}/${created.id}`;
    expect(
      (
        await h.request(base, {
          cookie,
          method: "POST",
          body: { name: "Too many", paths: ["/a.docx"], scope: "read", maxDownloads: overLimit },
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.request(path, { cookie, method: "PATCH", body: { maxDownloads: overLimit } }))
        .status,
    ).toBe(400);
    expect(ManagedShare.parse(await (await h.request(path, { cookie })).json()).maxDownloads).toBe(
      2_147_483_647,
    );
  });

  it("answers for storage that no longer shares, or cannot be reached, without a share", async () => {
    let strategy: ProviderModule["shares"] = "owned";
    const h = sharesHarness({
      local: (module) => ({
        ...module,
        get shares() {
          return strategy;
        },
      }),
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);
    strategy = "none";
    for (const response of [
      await h.request(base, { cookie }),
      await h.request(`${base}/${id}`, { cookie }),
      await h.request(pub(id)),
      await h.request(`${pub(id)}/download`),
    ]) {
      expect(response.status).toBe(400);
      expect(await error(response)).toMatchObject({
        kind: "unsupported",
        details: { capability: "shares" },
      });
    }
    strategy = "owned";
    vi.spyOn(h.providers, "forIdentity").mockRejectedValue(new Error("private detail"));
    const unreachable = await h.request(pub(id));
    expect(unreachable.status).toBe(502);
    expect(await unreachable.text()).not.toContain("private detail");
  });

  it("records share create, update and revoke per account without copying any secret", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const bob = await h.login("bob");
    const share = await h.create(cookie, { password: "hunter2", expiresAt: null });
    expect(h.activity.operations.at(-1)).toMatchObject({
      action: "share.create",
      requested: { path: "/a.docx", permissions: ["read"] },
    });
    expect(h.activity.outcomes.at(-1)).toMatchObject({
      outcome: "success",
      after: { shareId: share.id },
    });
    expect(JSON.stringify(h.activity.operations)).not.toContain("hunter2");
    expect(JSON.stringify(h.activity.outcomes)).not.toContain("hunter2");
    // The same path shared by a second account is that account's own event.
    await h.create(bob);
    expect(h.activity.operations.at(-1)?.accountId).not.toBe(
      h.activity.operations.at(-2)?.accountId,
    );
    const path = `${base}/${share.id}`;
    expect(
      (await h.request(path, { method: "PATCH", cookie, body: { name: "Renamed" } })).status,
    ).toBe(200);
    expect(h.activity.operations.at(-1)).toMatchObject({
      action: "share.update",
      requested: { shareId: share.id },
      before: { permissions: ["read"] },
    });
    expect((await h.request(path, { method: "DELETE", cookie })).status).toBe(200);
    expect(h.activity.operations.at(-1)?.action).toBe("share.revoke");
    expect(h.activity.outcomes.at(-1)).toMatchObject({ outcome: "success" });
  });

  it("records a refused share as a failure and says nothing private", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    vi.spyOn(h.shares, "insert").mockRejectedValueOnce(new Error("secret DB failure"));
    const response = await h.request(base, {
      method: "POST",
      cookie,
      body: { name: "Doc", paths: ["/a.docx"], scope: "read" },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
    expect(h.activity.outcomes.at(-1)).toMatchObject({ outcome: "unknown" });
    expect(SharesResponse.parse(await (await h.request(base, { cookie })).json()).items).toEqual(
      [],
    );
  });
});

describe("public shares", () => {
  it("does not let unknown share IDs exhaust limiter capacity for a real share", async () => {
    const h = sharesHarness({ limiterCapacity: 2 });
    const cookie = await h.login();
    const share = await h.create(cookie);
    for (const unknownId of [
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ])
      expect((await h.request(pub(unknownId))).status).toBe(404);
    expect(
      (
        await h.request("/api/v1/public/shares/00000000-0000-4000-8000-000000000004/credentials", {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect((await h.request(pub(share.id))).status).toBe(200);
  });

  it("checks cached limiter state before denied repository traffic and revalidates access", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const credentialShare = await h.create(cookie);
    const revokedShare = await h.create(cookie);
    const revokedRow = await h.shares.get(revokedShare.id);
    if (revokedRow === null) throw new Error("missing share row");
    const get = vi.spyOn(h.shares, "get");

    const unknown = pub("00000000-0000-4000-8000-000000000005");
    for (let request = 0; request < 120; request++)
      expect((await h.request(unknown)).status).toBe(404);
    const afterUnknownLimit = get.mock.calls.length;
    expect(afterUnknownLimit).toBe(121);
    expect((await h.request(unknown)).status).toBe(429);
    expect(get).toHaveBeenCalledTimes(afterUnknownLimit);

    const credentials = `${pub(credentialShare.id)}/credentials`;
    const beforeCredentials = get.mock.calls.length;
    for (let request = 0; request < 10; request++)
      expect(
        (await h.request(credentials, { method: "POST", body: { password: "guess" } })).status,
      ).toBe(200);
    expect(get.mock.calls.length - beforeCredentials).toBe(11);
    const afterCredentialLimit = get.mock.calls.length;
    expect(
      (await h.request(credentials, { method: "POST", body: { password: "guess" } })).status,
    ).toBe(429);
    expect(get).toHaveBeenCalledTimes(afterCredentialLimit);

    const revoked = pub(revokedShare.id);
    const beforeRevocation = get.mock.calls.length;
    expect((await h.request(revoked)).status).toBe(200);
    expect(get.mock.calls.length - beforeRevocation).toBe(2);
    await h.shares.removeOwned(revokedRow.identityId, revokedShare.id);
    expect((await h.request(revoked)).status).toBe(404);
    expect(get.mock.calls.length - beforeRevocation).toBe(3);
  });

  it("checks the password once, seals only a marker, and withholds details until it verifies", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, {
      password: "secret",
      maxDownloads: 2,
      description: "Quarterly numbers",
      expiresAt: new Date(h.clock().getTime() + 86_400_000).toISOString(),
    });
    const path = pub(id);
    // Holding the UUID alone reveals nothing beyond "protected, viewable, not expired".
    const withheld = {
      name: "",
      description: "",
      layout: "directory",
      presentation: "auto",
      fileName: null,
      hasPassword: true,
      credentialPresent: false,
      expiresAt: null,
      maxDownloads: 0,
      usedDownloads: 0,
      unavailableReason: null,
    };
    expect(await metadata(h, id)).toMatchObject(withheld);
    const anonymous = await h.request(`${path}/download`);
    expect(anonymous.status).toBe(401);
    expect((await error(anonymous)).details).toEqual({ reason: "password" });
    for (const password of ["nope", "\0".repeat(1024)]) {
      const wrong = await h.request(`${path}/credentials`, { method: "POST", body: { password } });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get("set-cookie")).toBeNull();
    }
    const right = await h.request(`${path}/credentials`, {
      method: "POST",
      body: { password: "secret" },
    });
    expect(right.status).toBe(200);
    expect(right.headers.get("set-cookie")).toContain(`Path=${path}`);
    expect(right.headers.get("set-cookie")).toContain("HttpOnly");
    const envelope = cookieFrom(right);
    expect(envelope).not.toContain("secret");
    expect(await metadata(h, id, envelope)).toMatchObject({
      name: "Document",
      description: "Quarterly numbers",
      layout: "single-file",
      fileName: "a.docx",
      hasPassword: true,
      credentialPresent: true,
      maxDownloads: 2,
    });
    const ranged = await h.request(`${path}/download`, {
      cookie: envelope,
      headers: { range: "bytes=1-3" },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("lic");
    expect(ranged.headers.get("content-range")).toBe("bytes 1-3/10");
    expect(ranged.headers.get("content-disposition")).toContain("attachment");
    expect(ranged.headers.get("content-disposition")).toContain("a.docx");
    expect(ranged.headers.get("cache-control")).toBe("no-store");
    expect(ranged.headers.get("referrer-policy")).toBe("no-referrer");
    expect(ranged.headers.get("x-content-type-options")).toBe("nosniff");

    // A new password retires every cookie issued for the old one.
    expect(
      (await h.request(`${base}/${id}`, { cookie, method: "PATCH", body: { password: "other" } }))
        .status,
    ).toBe(200);
    expect((await h.request(`${path}/download`, { cookie: envelope })).status).toBe(401);
    expect((await metadata(h, id, envelope)).credentialPresent).toBe(false);
    const renewed = cookieFrom(
      await h.request(`${path}/credentials`, { method: "POST", body: { password: "other" } }),
    );
    expect(await (await h.request(`${path}/download`, { cookie: renewed })).text()).toBe(
      "alice data",
    );
    expect((await metadata(h, id)).unavailableReason).toBe("limit");
    expect((await h.request(`${path}/archive`, { cookie: renewed })).status).toBe(403);

    // Removing the password opens the link to everyone.
    expect(
      (await h.request(`${base}/${id}`, { cookie, method: "PATCH", body: { password: "" } }))
        .status,
    ).toBe(200);
    expect(await metadata(h, id)).toMatchObject({ hasPassword: false, name: "Document" });
    const cleared = await h.request(`${path}/credentials`, { method: "DELETE" });
    expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("keeps a link carried over from SFTPGo locked to every password until its owner sets one", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { password: "secret" });
    const row = await h.shares.get(id);
    if (row === null) throw new Error("missing row");
    // What the migration wrote for a protected SFTPGo link, whose password SFTPGo kept.
    await h.shares.updateOwned(row.identityId, id, {
      ...row,
      passwordHash: "locked$sftpgo",
      at: h.clock(),
    });
    for (const password of ["secret", "", "locked$sftpgo", "sftpgo"])
      expect(
        (await h.request(`${pub(id)}/credentials`, { method: "POST", body: { password } })).status,
        password,
      ).toBe(401);
    expect(await metadata(h, id)).toMatchObject({ hasPassword: true, name: "" });
    expect((await h.request(`${pub(id)}/download`)).status).toBe(401);
    expect(
      ManagedShare.parse(await (await h.request(`${base}/${id}`, { cookie })).json()).hasPassword,
    ).toBe(true);
    // A rename keeps the lock; a new password lifts it.
    await h.request(`${base}/${id}`, { cookie, method: "PATCH", body: { name: "Renamed" } });
    expect(await h.shares.passwordHash(id)).toBe("locked$sftpgo");
    await h.request(`${base}/${id}`, { cookie, method: "PATCH", body: { password: "fresh" } });
    const envelope = cookieFrom(
      await h.request(`${pub(id)}/credentials`, { method: "POST", body: { password: "fresh" } }),
    );
    expect(await (await h.request(`${pub(id)}/download`, { cookie: envelope })).text()).toBe(
      "alice data",
    );
  });

  it("serves a single file with HEAD, ranges, a 416, and the download limit", async () => {
    const h = sharesHarness();
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
    expect(await beyond.text()).toBe("");
    expect((await metadata(h, id)).usedDownloads).toBe(2);

    // A valid multi-range request is answered with the whole file, and counted once.
    const multi = await h.request(`${path}/download`, {
      headers: { range: "bytes=0-1,6-7", "if-range": "stale-validator" },
    });
    expect(multi.status).toBe(200);
    expect(multi.headers.get("content-range")).toBeNull();
    expect(await multi.text()).toBe("alice data");
    expect((await metadata(h, id)).usedDownloads).toBe(3);

    const refused = await h.request(`${path}/download`);
    expect(refused.status).toBe(403);
    expect((await error(refused)).details).toEqual({ reason: "limit" });
    expect((await metadata(h, id)).unavailableReason).toBe("limit");
  });

  it("lists a directory share without the hidden folders and serves its children", async () => {
    const h = sharesHarness({ trashPath: "/.trash" });
    h.write("/folder/a.txt", "content");
    h.write("/.trash/old.txt", "gone");
    h.write("/.fdrive-backups/b", "backup");
    h.write("/.fdrive-desktop/mac/trash/old.txt", "the Mac's Trash");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/"] });
    const path = pub(id);
    expect((await metadata(h, id)).layout).toBe("directory");
    expect((await names(await h.request(`${path}/entries`))).sort()).toEqual([
      "a.docx",
      "folder",
      "report.txt",
    ]);
    expect(await names(await h.request(`${path}/entries?path=/folder`))).toEqual(["a.txt"]);
    expect(await (await h.request(`${path}/download?path=/folder/a.txt`)).text()).toBe("content");
    for (const hidden of [
      "/.trash/old.txt",
      "/.fdrive-backups/b",
      "/.fdrive-desktop/mac/trash/old.txt",
      "/nope",
    ])
      expect((await h.request(`${path}/download?path=${hidden}`)).status, hidden).toBe(404);
    expect((await h.request(`${path}/entries?path=/.trash`)).status).toBe(404);
    // A link that followed its item into the Trash is not found until it comes back out.
    const trashed = await h.create(cookie, { paths: ["/folder"] });
    const row = await h.shares.get(trashed.id);
    if (row === null) throw new Error("missing row");
    h.write("/.trash/folder/a.txt", "content");
    await h.shares.movePrefix(row.identityId, "/folder", "/.trash/folder", true);
    for (const suffix of ["", "/entries", "/download?path=/a.txt"])
      expect((await h.request(`${pub(trashed.id)}${suffix}`)).status, suffix).toBe(404);
    await h.shares.movePrefix(row.identityId, "/.trash/folder", "/folder", true);
    expect((await metadata(h, trashed.id)).layout).toBe("directory");
    // A file share has no listing, and an archive share no single file.
    const file = await h.create(cookie);
    expect((await h.request(`${pub(file.id)}/entries`)).status).toBe(400);
    const many = await h.create(cookie, { paths: ["/a.docx", "/report.txt"] });
    expect((await metadata(h, many.id)).layout).toBe("archive");
    for (const suffix of ["entries", "download"])
      expect((await h.request(`${pub(many.id)}/${suffix}`)).status, suffix).toBe(400);
  });

  it("accepts uploads into an upload share, checked eagerly, and nothing else", async () => {
    const h = sharesHarness();
    h.mkdir("/inbox");
    const cookie = await h.login();
    const { id } = await h.create(cookie, {
      name: "Send me the contract",
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
    // The password was checked when the cookie was issued, so the share reveals itself.
    expect(await metadata(h, id, envelope)).toMatchObject({
      name: "Send me the contract",
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
    expect(h.read("/inbox/new.txt")).toBe("upload");
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
    // Several folders have no one place an upload would go.
    h.mkdir("/outbox");
    const several = await h.create(cookie, { paths: ["/inbox", "/outbox"], scope: "write" });
    expect(
      (await h.request(`${pub(several.id)}/upload?path=/x.txt`, { method: "PUT", raw: "x" }))
        .status,
    ).toBe(400);
    // An unprotected upload share shows everything to anyone with the link.
    const open = await h.create(cookie, { name: "Open inbox", paths: ["/inbox"], scope: "write" });
    expect(await metadata(h, open.id)).toMatchObject({
      name: "Open inbox",
      credentialPresent: false,
    });
  });

  it("expires", async () => {
    const h = sharesHarness();
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

  it("rejects traversal, malformed ranges, CSRF, credentials and rate abuse without data access", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie);
    const path = pub(id);
    for (const query of ["/../a", "/a//b", "/a\\b", "/a/."])
      expect((await h.request(`${path}/download?path=${encodeURIComponent(query)}`)).status).toBe(
        400,
      );
    expect((await h.request(`${path}/download?path=/a&path=/b`)).status).toBe(400);
    for (const range of [
      "bytes=4-2,6-7",
      "bytes=-0",
      "bytes=4-2",
      "bytes=9007199254740993-",
      "bytes=0-9007199254740993",
      "nonsense",
    ])
      expect((await h.request(`${path}/download`, { headers: { range } })).status, range).toBe(400);
    expect((await h.request(`${path}/upload?path=/folder/a`, { method: "PUT" })).status).toBe(400);
    expect((await h.request("/api/v1/public/shares/bad")).status).toBe(400);
    expect((await h.request(`${path}/credentials`, { method: "POST", raw: "oops" })).status).toBe(
      400,
    );
    expect(
      (await h.request(`${path}/credentials`, { method: "POST", body: { password: 3 } })).status,
    ).toBe(400);
    expect(
      (
        await h.request(`${path}/credentials`, {
          method: "POST",
          body: { password: "secret" },
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(`${path}/credentials`, {
          method: "POST",
          body: { password: "x".repeat(1025) },
        })
      ).status,
    ).toBe(400);
    for (let i = 0; i < 10; i++)
      await h.request(`${path}/credentials`, { method: "POST", body: { password: "x" } });
    expect(
      (await h.request(`${path}/credentials`, { method: "POST", body: { password: "x" } })).status,
    ).toBe(429);
  });

  it("bounds a chunked credential body", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(9000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await h.request(`${pub(id)}/credentials`, { method: "POST", raw: body });
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect((await h.request(`${pub(id)}/credentials`, { method: "POST" })).status).toBe(400);
  });

  it("shows a storage failure as unavailable, never as a password error", async () => {
    const h = sharesHarness({
      local: patchStorage((storage) => ({
        ...storage,
        download: async () => {
          throw new StorageError("forbidden", "AccessDenied: the owner's key was refused");
        },
      })),
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie, { password: "secret" });
    const envelope = cookieFrom(
      await h.request(`${pub(id)}/credentials`, { method: "POST", body: { password: "secret" } }),
    );
    const failed = await h.request(`${pub(id)}/download`, { cookie: envelope });
    expect(failed.status).toBe(502);
    const body = await failed.text();
    expect(ApiError.parse(JSON.parse(body)).error.kind).toBe("upstream_unavailable");
    expect(body).not.toContain("AccessDenied");
    expect((await metadata(h, id, envelope)).usedDownloads).toBe(0);
  });

  it("is unavailable once its owner may no longer sign in", async () => {
    let admitted = true;
    const h = sharesHarness({
      local: (module) => ({
        ...module,
        admit: async () => {
          if (!admitted) throw new StorageError("forbidden", "this user may not sign in");
        },
      }),
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);
    admitted = false;
    for (const suffix of ["", "/download"]) {
      const response = await h.request(`${pub(id)}${suffix}`);
      expect(response.status, suffix).toBe(502);
      expect((await error(response)).kind).toBe("upstream_unavailable");
    }
  });
});

describe("contentLengthExceeds", () => {
  it("is false when the header is absent, at or under the limit, or not a number", () => {
    expect(contentLengthExceeds(undefined, 100)).toBe(false);
    expect(contentLengthExceeds("100", 100)).toBe(false);
    expect(contentLengthExceeds("50", 100)).toBe(false);
    expect(contentLengthExceeds("not-a-number", 100)).toBe(false);
  });
  it("is true when the header exceeds the limit", () => {
    expect(contentLengthExceeds("101", 100)).toBe(true);
  });
});

describe("capByteStream", () => {
  function streamFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      },
    });
  }
  async function drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return { chunks, error: undefined };
    } catch (error) {
      return { chunks, error };
    }
  }

  it("passes every chunk through unchanged when the total stays under the cap", async () => {
    const cap = capByteStream(streamFrom(["ab", "cd"]), 10);
    const { chunks, error } = await drain(cap.stream);
    expect(error).toBeUndefined();
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("abcd");
    expect(cap.exceeded()).toBe(false);
  });
  it("errors the wrapped stream and reports exceeded once the total passes the cap", async () => {
    const cap = capByteStream(streamFrom(["abcde", "fghij", "k"]), 8);
    expect(cap.exceeded()).toBe(false);
    const { error } = await drain(cap.stream);
    expect(error).toBeInstanceOf(Error);
    expect(cap.exceeded()).toBe(true);
  });
  it("cancels the source reader when the wrapped stream is cancelled from outside", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
      },
      cancel,
    });
    const cap = capByteStream(source, 100);
    await cap.stream.cancel("consumer gave up");
    expect(cancel).toHaveBeenCalledWith("consumer gave up");
  });
});

function streamOfZeros(chunkCount: number, chunkSize: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
}

describe("PUT /public/shares/:id/upload byte ceiling", () => {
  async function inbox(maxBytes: number) {
    const h = sharesHarness({ config: { fdriveShareUploadMaxBytes: maxBytes } });
    h.mkdir("/folder");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/folder"], scope: "write" });
    return { h, url: (name: string) => `${pub(id)}/upload?path=/${name}` };
  }

  it("rejects an upload whose declared Content-Length exceeds the configured ceiling", async () => {
    const { h, url } = await inbox(10);
    const response = await h.request(url("new.txt"), {
      method: "PUT",
      raw: "short body",
      headers: { "content-length": "1000" },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { kind: "payload_too_large" } });
  });

  it("rejects an upload whose streamed bytes exceed the ceiling with no Content-Length header", async () => {
    const { h, url } = await inbox(10);
    const response = await h.request(url("new.txt"), { method: "PUT", raw: streamOfZeros(5, 5) });
    expect(response.status).toBe(413);
  });

  it("stores an upload at or under the ceiling, and an empty one", async () => {
    const { h, url } = await inbox(1024);
    expect((await h.request(url("new.txt"), { method: "PUT", raw: "small" })).status).toBe(200);
    expect(h.read("/folder/new.txt")).toBe("small");
    expect((await h.request(url("empty.txt"), { method: "PUT" })).status).toBe(200);
    expect(h.read("/folder/empty.txt")).toBe("");
  });

  it("does not relabel an unrelated upload failure under the cap as payload_too_large", async () => {
    const { h, url } = await inbox(1024);
    // The shared folder was replaced by a file after the link was made, so
    // the upload fails for a reason unrelated to the byte cap.
    h.remove("/folder");
    h.write("/folder", "now a file");
    const response = await h.request(url("new.txt"), { method: "PUT", raw: "small" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBe(413);
  });
});

function makeIndexedFile(overrides: Partial<IndexedFile> = {}): IndexedFile {
  return {
    id: 1,
    rootId: 1,
    path: "alice/a.docx",
    name: "a.docx",
    ext: ".docx",
    size: 100,
    mtimeNs: 1n,
    sha256: "abc123",
    mime: null,
    textStatus: "done",
    textChars: 0,
    error: null,
    indexedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const ALICE_HOME_SCOPES = [{ rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" }];

/** A shares app whose public thumb route has an index and a thumbnail cache. */
function thumbsHarness(
  overrides: {
    indexQueries?: Partial<Pick<IndexQueries, "rootIdsByName" | "fileByPath" | "thumbnail">>;
    resolver?: Pick<ScopeResolver, "verifiedIndexScopes">;
    /** `null` disables the route (the default is `"/thumbs"`). */
    thumbsDir?: string | null;
    fileReader?: Partial<ThumbFileReader>;
    thumbnailsEnabled?: () => Promise<boolean>;
  } = {},
) {
  const thumbsDir = overrides.thumbsDir === null ? undefined : (overrides.thumbsDir ?? "/thumbs");
  return sharesHarness({
    routes: {
      indexQueries: {
        rootIdsByName: async () => ({ files: 1 }),
        fileByPath: async () => makeIndexedFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
        ...overrides.indexQueries,
      },
      resolver: overrides.resolver ?? {
        verifiedIndexScopes: async () => ({ available: true, scopes: ALICE_HOME_SCOPES }),
      },
      thumbsDir,
      fileReader: {
        stat: async () => ({ size: 42 }),
        readStream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("webp-bytes"));
              controller.close();
            },
          }),
        ...overrides.fileReader,
      },
      ...(overrides.thumbnailsEnabled === undefined
        ? {}
        : { thumbnailsEnabled: overrides.thumbnailsEnabled }),
    },
  });
}

describe("GET /public/shares/:id/thumb", () => {
  const thumb = (id: string, query = "path=%2F&size=256") => `${pub(id)}/thumb?${query}`;

  it("streams the shared file's own thumbnail, cacheable for a minute, without spending", async () => {
    const fileByPath = vi.fn(async () => makeIndexedFile());
    const h = thumbsHarness({ indexQueries: { fileByPath } });
    const cookie = await h.login();
    const { id } = await h.create(cookie, { maxDownloads: 1 });
    const res = await h.request(thumb(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBe("42");
    // The one public share response that is not "no-store": bounded to a
    // minute, and "private" so no shared proxy cache ever holds it.
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(res.headers.get("etag")).toBe('"abc123"');
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("webp-bytes");
    expect(fileByPath).toHaveBeenCalledWith(1, "alice/a.docx");
    expect((await h.request(thumb(id, "size=256"))).status).toBe(200);
    expect((await metadata(h, id)).usedDownloads).toBe(0);
    expect((await h.request(`${pub(id)}/download`)).headers.get("cache-control")).toBe("no-store");
  });

  it("streams a thumbnail for a file inside a directory share", async () => {
    const fileByPath = vi.fn(async () => makeIndexedFile({ path: "alice/folder/photo.jpg" }));
    const h = thumbsHarness({ indexQueries: { fileByPath } });
    h.mkdir("/folder");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/folder"] });
    expect((await h.request(thumb(id, "path=%2Fphoto.jpg&size=1024"))).status).toBe(200);
    expect(fileByPath).toHaveBeenCalledWith(1, "alice/folder/photo.jpg");
  });

  it("404s for every malformed request, without saying why", async () => {
    const h = thumbsHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie);
    for (const query of [
      "path=%2F&size=512",
      "path=%2F",
      "path=%2Fa&path=%2Fb&size=256",
      ...["..%2F", "/a/../b", "//", "/a\\b", "C:\\Windows\\win.ini"].map(
        (path) => `path=${encodeURIComponent(path)}&size=256`,
      ),
      // `SharePath` allows a segment over 255 bytes; normalization does not.
      `path=${encodeURIComponent(`/${"a".repeat(300)}.jpg`)}&size=256`,
    ]) {
      const res = await h.request(thumb(id, query));
      expect(res.status, query).toBe(404);
      expect(await error(res)).toMatchObject({ kind: "not_found" });
    }
    expect((await h.request(thumb("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });

  it("404s inside the folders no link reaches, where a link follows its item to", async () => {
    const fileByPath = vi.fn(async () => makeIndexedFile());
    const h = thumbsHarness({ indexQueries: { fileByPath } });
    h.mkdir("/folder");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/"] });
    for (const path of ["/Shared with me/team/x.jpg", "/.fdrive-desktop/x.jpg"])
      expect(
        (await h.request(thumb(id, `path=${encodeURIComponent(path)}&size=256`))).status,
        path,
      ).toBe(404);
    const folder = await h.create(cookie, { paths: ["/folder"] });
    const row = await h.shares.get(folder.id);
    if (row === null) throw new Error("missing row");
    await h.shares.movePrefix(row.identityId, "/folder", "/Shared with me/team/folder", true);
    expect((await h.request(thumb(folder.id, "path=%2Fx.jpg&size=256"))).status).toBe(404);
    expect(fileByPath).not.toHaveBeenCalled();
  });

  it("404s when thumbnails are off or not configured", async () => {
    for (const h of [
      thumbsHarness({ thumbsDir: null }),
      thumbsHarness({ thumbnailsEnabled: async () => false }),
    ]) {
      const { id } = await h.create(await h.login());
      expect((await h.request(thumb(id))).status).toBe(404);
    }
    const on = thumbsHarness({ thumbnailsEnabled: async () => true });
    const { id } = await on.create(await on.login());
    expect((await on.request(thumb(id))).status).toBe(200);
  });

  it("404s for a write share, an archive share, an expired or spent one", async () => {
    const h = thumbsHarness();
    h.mkdir("/folder");
    const cookie = await h.login();
    const write = await h.create(cookie, { paths: ["/folder"], scope: "write" });
    expect((await h.request(thumb(write.id, "path=%2Fa.jpg&size=256"))).status).toBe(404);
    const archive = await h.create(cookie, { paths: ["/a.docx", "/report.txt"] });
    expect((await h.request(thumb(archive.id))).status).toBe(404);
    const spent = await h.create(cookie, { maxDownloads: 1 });
    await (await h.request(`${pub(spent.id)}/download`)).text();
    expect((await h.request(thumb(spent.id))).status).toBe(404);
    const expiring = await h.create(cookie, {
      expiresAt: new Date(h.clock().getTime() + 1000).toISOString(),
    });
    h.now.value = new Date(h.clock().getTime() + 2000);
    expect((await h.request(thumb(expiring.id))).status).toBe(404);
  });

  it("serves a protected share's thumbnails only to its current password", async () => {
    const h = thumbsHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { password: "secret" });
    const path = pub(id);
    expect((await h.request(thumb(id))).status).toBe(404);
    const envelope = cookieFrom(
      await h.request(`${path}/credentials`, { method: "POST", body: { password: "secret" } }),
    );
    expect((await h.request(thumb(id), { cookie: envelope })).status).toBe(200);
    expect(
      (await h.request(`${base}/${id}`, { method: "PATCH", cookie, body: { password: "rotated" } }))
        .status,
    ).toBe(200);
    // The old cookie stops serving thumbnails at once.
    expect((await h.request(thumb(id), { cookie: envelope })).status).toBe(404);
    const rotated = cookieFrom(
      await h.request(`${path}/credentials`, { method: "POST", body: { password: "rotated" } }),
    );
    expect((await h.request(thumb(id), { cookie: rotated })).status).toBe(200);
    expect((await h.request(`${base}/${id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await h.request(thumb(id), { cookie: rotated })).status).toBe(404);
  });

  it("404s when the index has no thumbnail for the file", async () => {
    const cases: Parameters<typeof thumbsHarness>[0][] = [
      { indexQueries: { fileByPath: async () => null } },
      { indexQueries: { fileByPath: async () => makeIndexedFile({ sha256: null }) } },
      { indexQueries: { thumbnail: async () => null } },
      { indexQueries: { rootIdsByName: async () => ({}) } },
      {
        fileReader: {
          stat: async () => {
            throw new Error("ENOENT");
          },
        },
      },
      { resolver: { verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }) } },
      { resolver: { verifiedIndexScopes: async () => ({ available: true, scopes: [] }) } },
    ];
    for (const [index, overrides] of cases.entries()) {
      const h = thumbsHarness(overrides);
      const { id } = await h.create(await h.login());
      expect((await h.request(thumb(id))).status, String(index)).toBe(404);
    }
  });

  it("404s when the share or its owner cannot be loaded", async () => {
    const h = thumbsHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie);
    const load = h.service.publicThumbTarget.bind(h.service);
    const target = vi.spyOn(h.service, "publicThumbTarget");
    target.mockRejectedValueOnce(new Error("storage down"));
    expect((await h.request(thumb(id))).status).toBe(404);
    // The owner disappears between loading the share and resolving its index.
    let gone = false;
    target.mockImplementationOnce(async (...args) => {
      const loaded = await load(...args);
      gone = true;
      return loaded;
    });
    const get = h.repos.identities.get.bind(h.repos.identities);
    vi.spyOn(h.repos.identities, "get").mockImplementation(async (identityId) =>
      gone ? null : get(identityId),
    );
    expect((await h.request(thumb(id))).status).toBe(404);
    expect(gone).toBe(true);
  });
});
