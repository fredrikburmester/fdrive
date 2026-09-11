import { SftpgoError } from "@fdrive/sftpgo";
import { Context } from "hono";
import { expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.ts";
import { attachment, downloadResponse, publicCall, publicDownloadOptions } from "./routes.ts";
import { shareCall } from "./service.ts";
import { sharesHarness } from "./test-fixtures/index.ts";

it("sanitizes errors without treating generic400 as successful password verification", async () => {
  for (const kind of ["not_found", "unauthorized", "forbidden", "bad_request", "server"] as const) {
    const error = new SftpgoError("private server detail", kind, 500, "private");
    await expect(
      shareCall(async () => {
        throw error;
      }),
    ).rejects.not.toHaveProperty("message", "private server detail");
    await expect(
      publicCall(async () => {
        throw error;
      }, false),
    ).rejects.toBeInstanceOf(ApiHttpError);
  }
  await expect(
    publicCall(async () => {
      throw new SftpgoError("wrong", "forbidden", 403, null);
    }, true),
  ).rejects.toMatchObject({ kind: "unauthorized" });
  const own = new ApiHttpError("bad_request", "safe");
  await expect(
    shareCall(async () => {
      throw own;
    }),
  ).rejects.toBe(own);
  await expect(
    publicCall(async () => {
      throw new Error("sensitive");
    }, true),
  ).rejects.toMatchObject({ kind: "upstream_unavailable" });
  expect(attachment("a\n'()*文.svg")).toContain("%27%28%29%2A");
  const response = downloadResponse(
    {
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      contentLength: null,
      contentRange: null,
      contentType: null,
      lastModified: null,
    },
    "a",
  );
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  for (const range of ["bytes=-3", "bytes=2-"]) {
    const ctx = new Context(
      new Request("http://test/", { headers: { range, "if-range": "etag" } }),
    );
    expect(publicDownloadOptions(ctx)).toMatchObject({ rangeHeader: range, ifRange: "etag" });
  }
  const multiRange = new Context(
    new Request("http://test/", {
      headers: { range: "bytes=0-1, 4-5", "if-range": "etag" },
    }),
  );
  expect(publicDownloadOptions(multiRange)).not.toMatchObject({
    rangeHeader: expect.anything(),
    ifRange: expect.anything(),
  });
});
it("reports failed compensation, ownership change, unavailable upstream and layout failure", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const original = h.client.user.bind(h.client);
  const userSpy = vi.spyOn(h.client, "user").mockImplementation((token) => {
    const api = original(token);
    return {
      ...api,
      shares: {
        ...api.shares,
        remove: async () => {
          throw new Error("private cleanup failure");
        },
      },
    };
  });
  const upsert = vi
    .spyOn(h.shares, "upsert")
    .mockRejectedValueOnce(new Error("private DB failure"));
  expect(
    (
      await h.request("/api/v1/shares", {
        cookie,
        method: "POST",
        body: { name: "Failure", paths: ["/a.docx"], scope: "read" },
      })
    ).status,
  ).toBe(502);
  expect(h.logger.error).toHaveBeenCalledWith("Share creation compensation failed");
  upsert.mockRestore();
  userSpy.mockRestore();
  const share = await h.create(cookie);
  const row = await h.shares.get(share.id);
  if (!row) throw new Error("missing row");
  vi.spyOn(h.repos.identities, "get").mockResolvedValueOnce(null);
  await expect(h.service.publicMetadata(share.id, undefined)).rejects.toMatchObject({
    kind: "not_found",
  });
  const failure = vi.spyOn(h.client, "user").mockImplementation((token) => {
    const api = original(token);
    return {
      ...api,
      shares: {
        ...api.shares,
        get: async () => {
          throw new SftpgoError("private", "network", null, null);
        },
      },
      statFile: async () => {
        throw new SftpgoError("private", "forbidden", 403, null);
      },
    };
  });
  expect((await h.request("/api/v1/shares", { cookie })).status).toBe(502);
  expect((await h.request(`/api/v1/public/shares/${share.id}`)).status).toBe(502);
  failure.mockRestore();
  const layoutFailure = vi.spyOn(h.client, "user").mockImplementation((token) => ({
    ...original(token),
    statFile: async () => {
      throw new SftpgoError("private", "forbidden", 403, null);
    },
  }));
  expect((await h.request(`/api/v1/public/shares/${share.id}`)).status).toBe(403);
  layoutFailure.mockRestore();
  for (const provider of await h.repos.providers.list())
    await h.repos.providers.update(provider.id, { enabled: false });
  await expect(h.service.publicMetadata(share.id, undefined)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
});
it("publicThumbTarget and verifySharePassword expose exactly what the public thumb route needs", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const auth = await h.client.login({ username: "alice", password: "alice-pass" });
  await h.client.user(auth.accessToken).mkdir("/folder");
  const { id } = await h.create(cookie, { paths: ["/folder"], password: "secret" });
  const row = await h.shares.get(id);
  if (!row) throw new Error("missing row");

  const target = await h.service.publicThumbTarget(id);
  expect(target).toMatchObject({
    identityId: row.identityId,
    sftpgoShareId: row.sftpgoShareId,
    scope: "read",
    paths: ["/folder"],
    hasPassword: true,
    unavailableReason: null,
  });

  await expect(
    h.service.publicThumbTarget("00000000-0000-4000-8000-000000000000"),
  ).rejects.toThrow();

  await expect(
    h.service.verifySharePassword(target.identityId, target.sftpgoShareId, "wrong"),
  ).resolves.toBe(false);
  // A directory share (unlike a single-file one) actually completes the
  // root listing, so the correct password hits the plain success path
  // rather than the single-file "bad_request" fallback.
  await expect(
    h.service.verifySharePassword(target.identityId, target.sftpgoShareId, "secret"),
  ).resolves.toBe(true);

  const publicShareSpy = vi.spyOn(h.client, "publicShare").mockReturnValueOnce({
    downloadFile: () => Promise.reject(new Error("not used")),
    list: () => Promise.reject(new Error("upstream exploded")),
    download: () => Promise.reject(new Error("not used")),
    zip: () => Promise.reject(new Error("not used")),
    upload: () => Promise.reject(new Error("not used")),
  });
  await expect(
    h.service.verifySharePassword(target.identityId, target.sftpgoShareId, "secret"),
  ).rejects.toThrow("upstream exploded");
  publicShareSpy.mockRestore();
});
it("preserves upstream IP restrictions and refuses unsupported scope before PATCH", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const { id } = await h.create(cookie);
  const row = await h.shares.get(id);
  if (!row) throw new Error("missing");
  const upstream = h.server.state.shares.get(row.sftpgoShareId);
  if (!upstream) throw new Error("missing upstream");
  upstream.allowFrom = ["127.0.0.0/8"];
  expect(
    (await h.request(`/api/v1/shares/${id}`, { cookie, method: "PATCH", body: { name: "New" } }))
      .status,
  ).toBe(200);
  expect(upstream.allowFrom).toEqual(["127.0.0.0/8"]);
  upstream.scope = 3;
  expect(
    (await h.request(`/api/v1/shares/${id}`, { cookie, method: "PATCH", body: { name: "No" } }))
      .status,
  ).toBe(400);
  expect(upstream.scope).toBe(3);
  expect(upstream.name).toBe("New");
  expect((await h.request(`/api/v1/public/shares/${id}`)).status).toBe(400);
});
it("pins share clients to the checked provider and refuses changes before owner token use", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const { id } = await h.create(cookie);
  const factory = vi.spyOn(h.deps, "clientFor");
  await h.service.publicAccess(id, undefined, "read");
  expect(factory).toHaveBeenCalledWith("http://storage.test");
  vi.spyOn(h.deps, "clientFor").mockImplementation(() => {
    // The provider is disabled between the ownership check and the token use.
    void h.repos.providers
      .list()
      .then((rows) =>
        Promise.all(rows.map((row) => h.repos.providers.update(row.id, { enabled: false }))),
      );
    return h.client;
  });
  const user = vi.spyOn(h.client, "user");
  await expect(h.service.publicMetadata(id, undefined)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  expect(user).not.toHaveBeenCalled();
});
it("bounds chunked JSON and leaves no mirror when layout validation fails", async () => {
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
  const res = await h.app.request(`/api/v1/public/shares/${id}/credentials`, {
    method: "POST",
    headers: { "x-requested-with": "fdrive" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  expect(res.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(
    (await h.request(`/api/v1/public/shares/${id}/credentials`, { method: "POST" })).status,
  ).toBe(400);
  const before = await h.shares.get(id);
  if (!before) throw new Error("missing");
  const rows = await h.shares.listOwned(before.identityId);
  const original = h.client.user.bind(h.client);
  vi.spyOn(h.client, "user").mockImplementation((token) => ({
    ...original(token),
    statFile: async () => {
      throw new SftpgoError("no", "not_found", 404, null);
    },
  }));
  expect(
    (
      await h.request("/api/v1/shares", {
        cookie,
        method: "POST",
        body: { name: "Bad layout", paths: ["/a.docx"], scope: "read" },
      })
    ).status,
  ).toBe(404);
  expect(await h.shares.listOwned(before.identityId)).toEqual(rows);
});
