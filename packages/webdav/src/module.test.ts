import { isStorageError, type ProviderInstance, type StorageSession } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { createWebdavClient } from "./client.js";
import { createFakeWebdavServer } from "./fake/server.js";
import { createWebdavModule, WEBDAV_CREDENTIAL_FIELDS, webdavModule } from "./module.js";

const INSTANCE: ProviderInstance = { id: "p1", baseUrl: "http://webdav.test/dav", config: {} };
const ALICE = { username: "alice", password: "secret" };

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : `not a StorageError: ${String(error)}`;
  }
}

function fakeCtx() {
  const server = createFakeWebdavServer({
    users: [ALICE],
    prefix: "/dav",
    files: { "/docs/a.txt": "hello" },
  });
  return { server, ctx: { fetch: server.fetch } };
}

function session(
  externalUsername: string,
  credential: Record<string, string>,
): StorageSession & { getCredential: ReturnType<typeof vi.fn> } {
  const getCredential = vi.fn(async () => credential);
  return {
    externalUsername,
    getCredential,
    getToken: async () => null,
    invalidateToken: async () => {},
  };
}

describe("webdavModule metadata", () => {
  it("describes the type, its fields and its capabilities", () => {
    expect(webdavModule.type).toBe("webdav");
    expect(webdavModule.label).toBe("WebDAV");
    expect(webdavModule.attribution).toBeUndefined();
    expect(webdavModule.configFields).toEqual([]);
    expect(webdavModule.credentialFields).toBe(WEBDAV_CREDENTIAL_FIELDS);
    expect(webdavModule.credentialFields.map((field) => field.name)).toEqual([
      "username",
      "password",
    ]);
    expect(webdavModule.credentialFields.find((field) => field.name === "password")?.kind).toBe(
      "password",
    );
    expect(webdavModule.capabilities).toEqual({
      zip: false,
      setModifiedAt: false,
      atomicMove: true,
      trash: true,
      shares: false,
      office: false,
      index: false,
      scopeMapping: false,
    });
    expect(webdavModule.trash).toBe("move");
    expect(webdavModule.mint).toBeUndefined();
    expect(webdavModule.indexRootName).toBeUndefined();
  });
});

describe("probe", () => {
  it("delegates to the OPTIONS probe with the context's fetch", async () => {
    const { server, ctx } = fakeCtx();
    expect(await webdavModule.probe(INSTANCE, ctx)).toEqual({
      ok: true,
      detail: "WebDAV is reachable (class 1, 2)",
    });
    expect(server.requests[0]).toMatchObject({ method: "OPTIONS", url: "http://webdav.test/dav/" });
  });
});

describe("authenticate", () => {
  it("verifies the credential against the endpoint root and returns the username", async () => {
    const { server, ctx } = fakeCtx();
    expect(await webdavModule.authenticate(INSTANCE, ALICE, ctx)).toEqual({
      externalUsername: "alice",
    });
    expect(server.requests.at(-1)).toMatchObject({
      method: "PROPFIND",
      url: "http://webdav.test/dav/",
      headers: { depth: "0" },
    });
  });

  it("fills a missing username from the expected one and refuses another user", async () => {
    const { ctx } = fakeCtx();
    expect(
      await webdavModule.authenticate(
        INSTANCE,
        { password: "secret" },
        { ...ctx, expectedUsername: "alice" },
      ),
    ).toEqual({ externalUsername: "alice" });
    expect(
      await kindOf(webdavModule.authenticate(INSTANCE, ALICE, { ...ctx, expectedUsername: "bob" })),
    ).toBe("unauthorized");
  });

  it("refuses an empty username or password before any request", async () => {
    const { server, ctx } = fakeCtx();
    expect(await kindOf(webdavModule.authenticate(INSTANCE, { password: "x" }, ctx))).toBe(
      "unauthorized",
    );
    expect(
      await kindOf(webdavModule.authenticate(INSTANCE, { username: "", password: "x" }, ctx)),
    ).toBe("unauthorized");
    expect(await kindOf(webdavModule.authenticate(INSTANCE, { username: "alice" }, ctx))).toBe(
      "unauthorized",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("maps a wrong password, a refused user, an unreachable server and a non-collection root", async () => {
    const { ctx } = fakeCtx();
    expect(
      await kindOf(
        webdavModule.authenticate(INSTANCE, { username: "alice", password: "wrong" }, ctx),
      ),
    ).toBe("unauthorized");

    const forbidden = vi.fn(
      async () => new Response("no", { status: 403 }),
    ) as unknown as typeof fetch;
    const forbiddenError = await webdavModule
      .authenticate(INSTANCE, ALICE, { fetch: forbidden })
      .catch((error: unknown) => error);
    expect(forbiddenError).toMatchObject({ kind: "forbidden", details: { detail: "no" } });

    const down = createFakeWebdavServer({ users: [ALICE] }).fetch;
    expect(
      await kindOf(
        webdavModule.authenticate({ ...INSTANCE, baseUrl: "http://elsewhere.test/" }, ALICE, {
          fetch: down,
        }),
      ),
    ).toBe("upstream_unavailable");

    const fileRoot = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/</D:href>
      <D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
      </D:response></D:multistatus>`;
    const notCollection = vi.fn(
      async () => new Response(fileRoot, { status: 207 }),
    ) as unknown as typeof fetch;
    const rootError = await webdavModule
      .authenticate(INSTANCE, ALICE, { fetch: notCollection })
      .catch((error: unknown) => error);
    expect(rootError).toMatchObject({
      kind: "upstream_unavailable",
      message: "WebDAV endpoint root is not a collection",
    });

    const broken = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await kindOf(webdavModule.authenticate(INSTANCE, ALICE, { fetch: broken }))).toBe(
      "upstream_unavailable",
    );
  });

  it("rethrows a failure that is not a protocol error", async () => {
    const client = createWebdavClient({ baseUrl: INSTANCE.baseUrl });
    const stat = vi.fn(async () => {
      throw new Error("odd");
    });
    const module = createWebdavModule({
      clientFor: () => ({
        ...client,
        user: () => ({ ...client.user(ALICE), stat }),
      }),
    });
    await expect(module.authenticate(INSTANCE, ALICE, { fetch: globalThis.fetch })).rejects.toThrow(
      "odd",
    );
  });
});

describe("createStorage", () => {
  it("binds storage to the identity's username and the session's unsealed password", async () => {
    const { server, ctx } = fakeCtx();
    const bound = session("alice", { username: "someone-else", password: "secret" });
    const storage = webdavModule.createStorage(INSTANCE, bound, ctx);
    expect((await storage.list("/")).map((entry) => entry.name)).toEqual(["docs"]);
    expect(bound.getCredential).toHaveBeenCalledTimes(1);
    expect(server.requests.at(-1)?.headers.authorization).toBe(
      `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    );
    const missingPassword = webdavModule.createStorage(INSTANCE, session("alice", {}), ctx);
    expect(await kindOf(missingPassword.list("/"))).toBe("unauthorized");
  });

  it("uses an injected client factory", async () => {
    const { ctx } = fakeCtx();
    const clientFor = vi.fn(() =>
      createWebdavClient({ baseUrl: "http://webdav.test/dav", fetch: ctx.fetch }),
    );
    const module = createWebdavModule({ clientFor });
    await module.authenticate(INSTANCE, ALICE, ctx);
    module.createStorage(INSTANCE, session("alice", ALICE), ctx);
    expect(clientFor).toHaveBeenCalledTimes(2);
    expect(clientFor).toHaveBeenCalledWith(INSTANCE, ctx);
  });
});
