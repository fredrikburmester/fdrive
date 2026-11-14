import { ManagedShare, PublicShare } from "@fdrive/contracts";
import { Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import { attachment, downloadResponse, publicDownloadOptions } from "./routes.ts";
import { cookieFrom, sharesHarness } from "./test-fixtures/index.ts";

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const pub = (id: string) => `/api/v1/public/shares/${id}`;

describe("public download helpers", () => {
  it("encodes the file name, defaults the type, and parses one range", () => {
    expect(attachment("a\n'()*文.svg")).toContain("%27%28%29%2A");
    expect(attachment("a\n'()*文.svg")).not.toContain("\n");
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
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBeNull();
    for (const [range, parsed] of [
      ["bytes=-3", { suffix: 3 }],
      ["bytes=2-", { start: 2 }],
      ["bytes=2-5", { start: 2, end: 5 }],
    ] as const) {
      const ctx = new Context(
        new Request("http://test/", { headers: { range, "if-range": "etag" } }),
      );
      expect(publicDownloadOptions(ctx)).toMatchObject({ range: parsed, ifRange: "etag" });
    }
    const multiRange = new Context(
      new Request("http://test/", { headers: { range: "bytes=0-1, 4-5", "if-range": "etag" } }),
    );
    expect(publicDownloadOptions(multiRange)).not.toMatchObject({
      range: expect.anything(),
      ifRange: expect.anything(),
    });
    expect(publicDownloadOptions(new Context(new Request("http://test/")))).toEqual({
      signal: expect.any(AbortSignal),
    });
  });
});

describe("the shares service", () => {
  it("publicThumbTarget says whether the visitor's credential opens the share", async () => {
    const h = sharesHarness();
    h.mkdir("/folder");
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/folder"], password: "secret" });
    const row = await h.shares.get(id);
    if (!row) throw new Error("missing row");
    expect(await h.service.publicThumbTarget(id, undefined)).toEqual({
      identityId: row.identityId,
      scope: "read",
      paths: ["/folder"],
      unavailableReason: null,
      unlocked: false,
      restricted: ["/.fdrive-desktop", "/Shared with me"],
    });
    const issued = await h.service.credential(id, "secret");
    expect((await h.service.publicThumbTarget(id, issued)).unlocked).toBe(true);
    expect((await h.service.publicThumbTarget(id, { verified: "forged" })).unlocked).toBe(false);
    await expect(h.service.credential(id, "wrong")).rejects.toMatchObject({
      kind: "unauthorized",
      details: { reason: "password" },
    });
    const open = await h.create(cookie);
    expect((await h.service.publicThumbTarget(open.id, undefined)).unlocked).toBe(true);
    await expect(h.service.publicThumbTarget(UNKNOWN, undefined)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("forgets a share whose owner is gone", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie);
    vi.spyOn(h.repos.identities, "get").mockResolvedValueOnce(null);
    await expect(h.service.publicMetadata(id, undefined)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect((await h.service.publicMetadata(id, undefined)).name).toBe("Document");
  });

  it("treats an empty password on create as none, and a row gone mid-edit as missing", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const created = await h.create(cookie, { password: "" });
    expect(created.hasPassword).toBe(false);
    vi.spyOn(h.shares, "updateOwned").mockResolvedValueOnce(null);
    const response = await h.request(`/api/v1/shares/${created.id}`, {
      cookie,
      method: "PATCH",
      body: { name: "Renamed" },
    });
    expect(response.status).toBe(404);
    expect(
      ManagedShare.parse(await (await h.request(`/api/v1/shares/${created.id}`, { cookie })).json())
        .name,
    ).toBe("Document");
  });

  it("reports a credential cookie on an unavailable protected share as present", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    const { id } = await h.create(cookie, {
      password: "secret",
      expiresAt: new Date(h.clock().getTime() + 1000).toISOString(),
    });
    const envelope = cookieFrom(
      await h.request(`${pub(id)}/credentials`, { method: "POST", body: { password: "secret" } }),
    );
    h.now.value = new Date(h.clock().getTime() + 2000);
    // Nothing can be served, so nothing is checked or revealed either.
    expect(
      PublicShare.parse(await (await h.request(pub(id), { cookie: envelope })).json()),
    ).toMatchObject({ unavailableReason: "expired", credentialPresent: true, name: "" });
  });
});
