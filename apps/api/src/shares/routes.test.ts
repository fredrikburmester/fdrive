import { ManagedShare, PublicShare, ShareEntriesResponse, SharesResponse } from "@fdrive/contracts";
import { expect, it, vi } from "vitest";
import { cookieFrom } from "../accounts/test-fixtures/index.ts";
import { sharesHarness } from "./test-fixtures/index.ts";

const base = "/api/v1/shares";
const publicBase = (id: string) => `/api/v1/public/shares/${id}`;
it("manages only selected session identity shares, preserves password, reconciles and revokes", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const bob = await h.login("bob");
  const share = await h.create(cookie, { password: "secret" });
  const path = `${base}/${share.id}`;
  expect((await h.request(path)).status).toBe(401);
  expect((await h.request(path, { cookie: bob })).status).toBe(404);
  expect(
    (await h.request(path, { cookie, headers: { authorization: "Bearer nope" } })).status,
  ).toBe(403);
  const get = ManagedShare.parse(await (await h.request(path, { cookie })).json());
  expect(get.publicPath).toBe(`/s/${share.id}`);
  expect(get).not.toHaveProperty("sftpgoShareId");
  expect(SharesResponse.parse(await (await h.request(base, { cookie })).json()).items).toHaveLength(
    1,
  );
  let response = await h.request(path, { cookie, method: "PATCH", body: { name: "Renamed" } });
  expect(response.status).toBe(200);
  expect(ManagedShare.parse(await response.json()).hasPassword).toBe(true);
  response = await h.request(path, { cookie, method: "PATCH", body: { password: "" } });
  expect(ManagedShare.parse(await response.json()).hasPassword).toBe(false);
  response = await h.request(path, { cookie, method: "PATCH", body: { password: "new" } });
  expect(ManagedShare.parse(await response.json()).hasPassword).toBe(true);
  expect((await h.request(path, { cookie, method: "PATCH", body: { allowFrom: [] } })).status).toBe(
    400,
  );
  expect((await h.request(path, { cookie, method: "DELETE" })).status).toBe(200);
  expect((await h.request(publicBase(share.id))).status).toBe(404);
  expect(
    await (
      await h.client
        .user((await h.client.login({ username: "alice", password: "alice-pass" })).accessToken)
        .download("/a.docx")
    ).body
      .getReader()
      .read(),
  ).toBeDefined();
});
it("public password cookie is unverified, encrypted, scoped; actual bytes enforce password and expiry", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const { id } = await h.create(cookie, { password: "secret", maxDownloads: 2 });
  const path = publicBase(id);
  const metadata = await h.request(path);
  expect(metadata.status).toBe(200);
  expect(PublicShare.parse(await metadata.json())).toMatchObject({
    layout: "single-file",
    fileName: "a.docx",
    hasPassword: true,
    credentialPresent: false,
  });
  expect((await h.request(`${path}/download`)).status).toBe(401);
  let response = await h.request(`${path}/credentials`, {
    method: "POST",
    body: { password: "wrong" },
  });
  expect(response.status).toBe(200);
  let envelope = cookieFrom(response);
  expect(response.headers.get("set-cookie")).toContain(`Path=${path}`);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(envelope).not.toContain("wrong");
  expect(
    PublicShare.parse(await (await h.request(path, { cookie: envelope })).json()).credentialPresent,
  ).toBe(true);
  expect((await h.request(`${path}/download`, { cookie: envelope })).status).toBe(401);
  response = await h.request(`${path}/credentials`, {
    method: "POST",
    body: { password: "secret" },
  });
  envelope = cookieFrom(response);
  response = await h.request(`${path}/download`, {
    cookie: envelope,
    headers: { range: "bytes=1-3" },
  });
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("lic");
  expect(response.headers.get("content-range")).toContain("bytes 1-3/");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(response.headers.get("content-disposition")).toContain("a.docx");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  response = await h.request(`${path}/download`, { cookie: envelope });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(PublicShare.parse(await (await h.request(path)).json()).unavailableReason).toBe("limit");
  expect((await h.request(`${path}/archive`, { cookie: envelope })).status).toBe(403);
  response = await h.request(`${path}/credentials`, { method: "DELETE" });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  const exp = await h.create(cookie, {
    expiresAt: new Date(h.clock().getTime() + 1000).toISOString(),
  });
  h.now.value = new Date(h.clock().getTime() + 2000);
  expect(
    PublicShare.parse(await (await h.request(publicBase(exp.id))).json()).unavailableReason,
  ).toBe("expired");
  expect((await h.request(`${publicBase(exp.id)}/download`)).status).toBe(403);
});
it("directory listing, child downloads, zip, write-only uploads and multipath isolation", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const auth = await h.client.login({ username: "alice", password: "alice-pass" });
  const user = h.client.user(auth.accessToken);
  await user.mkdir("/folder");
  await user.upload("/folder/a.txt", new TextEncoder().encode("content"));
  const directory = await h.create(cookie, { paths: ["/folder"] });
  const dir = publicBase(directory.id);
  expect(PublicShare.parse(await (await h.request(dir)).json()).layout).toBe("directory");
  expect(
    ShareEntriesResponse.parse(await (await h.request(`${dir}/entries`)).json()).items[0]?.name,
  ).toBe("a.txt");
  expect(await (await h.request(`${dir}/download?path=/a.txt`)).text()).toBe("content");
  const zip = await h.request(`${dir}/archive`);
  expect(zip.headers.get("content-type")).toBe("application/zip");
  expect((await zip.arrayBuffer()).byteLength).toBeGreaterThan(0);
  const multi = await h.create(cookie, { paths: ["/a.docx", "/report.txt"] });
  expect(PublicShare.parse(await (await h.request(publicBase(multi.id))).json()).layout).toBe(
    "archive",
  );
  for (const suffix of ["entries", "download"])
    expect((await h.request(`${publicBase(multi.id)}/${suffix}`)).status).toBe(400);
  const write = await h.create(cookie, { paths: ["/folder"], scope: "write" });
  const upload = publicBase(write.id);
  expect(PublicShare.parse(await (await h.request(upload)).json()).layout).toBe("directory");
  for (const suffix of ["entries", "download", "archive"])
    expect((await h.request(`${upload}/${suffix}`)).status).toBe(403);
  expect(
    (await h.request(`${upload}/upload?path=/new.txt`, { method: "PUT", raw: "upload" })).status,
  ).toBe(200);
  expect(await new Response((await user.download("/folder/new.txt")).body).text()).toBe("upload");
  expect(
    (await h.request(`${dir}/upload?path=/bad.txt`, { method: "PUT", raw: "bad" })).status,
  ).toBe(403);
});
it("rejects traversal, malformed ranges, CSRF, credentials and rate abuse without data access", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const { id } = await h.create(cookie);
  const path = publicBase(id);
  for (const query of ["/../a", "/a//b", "/a\\b", "/a/."])
    expect((await h.request(`${path}/download?path=${encodeURIComponent(query)}`)).status).toBe(
      400,
    );
  expect((await h.request(`${path}/download?path=/a&path=/b`)).status).toBe(400);
  for (const range of [
    "bytes=1-2,4-5",
    "bytes=-0",
    "bytes=4-2",
    "bytes=9007199254740993-",
    "bytes=0-9007199254740993",
    "nonsense",
  ])
    expect((await h.request(`${path}/download`, { headers: { range } })).status).toBe(400);
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
        body: { password: "\0".repeat(1024) },
      })
    ).status,
  ).toBe(400);
  for (let i = 0; i < 10; i++)
    await h.request(`${path}/credentials`, { method: "POST", body: { password: "x" } });
  expect(
    (await h.request(`${path}/credentials`, { method: "POST", body: { password: "x" } })).status,
  ).toBe(429);
});
it("compensates persistence failure, sanitizes compensation failure and reconciles upstream deletions", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const auth = await h.client.login({ username: "alice", password: "alice-pass" });
  const user = h.client.user(auth.accessToken);
  const spy = vi.spyOn(h.shares, "upsert").mockRejectedValueOnce(new Error("secret DB failure"));
  const response = await h.request(base, {
    cookie,
    method: "POST",
    body: { name: "Bad", paths: ["/a.docx"], scope: "read" },
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret");
  expect(await user.shares.list()).toHaveLength(0);
  spy.mockRestore();
  const share = await h.create(cookie);
  const row = await h.shares.get(share.id);
  if (!row) throw new Error("row missing");
  await user.shares.remove(row.sftpgoShareId);
  expect(SharesResponse.parse(await (await h.request(base, { cookie })).json()).items).toEqual([]);
  expect(await h.shares.get(share.id)).toBeNull();
  const gone = await h.create(cookie);
  const second = await h.shares.get(gone.id);
  if (!second) throw new Error("row missing");
  await user.shares.remove(second.sftpgoShareId);
  expect((await h.request(`${base}/${gone.id}`, { cookie, method: "DELETE" })).status).toBe(200);
  vi.spyOn(h.repos.providers, "get").mockResolvedValue(null);
  expect((await h.request(base, { cookie })).status).toBe(502);
});
