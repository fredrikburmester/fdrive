import { CreateApiTokenResponse, IDENTITY_HEADER, MeResponse } from "@fdrive/contracts";
import { createDb, migrate } from "@fdrive/db";
import { startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { verifyAccountCredentials } from "../../src/accounts/credentials.ts";
import { createLoginLimiter } from "../../src/auth/login-limiter.js";
import { hashSessionId } from "../../src/auth/sessions.js";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.ts";
import { createTokenSource } from "../../src/auth/token-source.js";
import { composedProviderFixture, providerFixture } from "./helpers/provider-binding-fixture.ts";
import { createBarrier, SHARED_PATH, USERNAME } from "./helpers/provider-binding-server.ts";

const unavailable = { kind: "upstream_unavailable" };
const McpResult = z.object({ result: z.object({ isError: z.boolean().optional() }) });
const jsonHeaders = { "content-type": "application/json", "x-requested-with": "fdrive" };

async function fixture() {
  const h = await providerFixture();
  onTestFinished(() => h.close());
  const identity = await h.seedIdentity();
  return { ...h, identity };
}

function expectUntouched(h: Awaited<ReturnType<typeof providerFixture>>) {
  expect(h.b.counts()).toEqual({
    requests: 0,
    passwords: 0,
    bearers: 0,
    mutations: 0,
    foreignCredentials: 0,
  });
  expect(h.a.counts().foreignCredentials).toBe(0);
}

describe("provider binding over two HTTP upstreams", () => {
  it("denies process and persisted cached tokens before any credential or upstream access", async () => {
    const h = await fixture();
    await h.tokens.get(h.identity.id);
    const restarted = createTokenSource(h.tokenDeps);
    const before = h.a.counts();
    await h.switchToB();
    let credentialReads = 0;
    const get = h.repos.credentials.get;
    h.repos.credentials.get = async (id) => {
      credentialReads++;
      return get(id);
    };
    for (const source of [h.tokens, restarted])
      await expect(source.get(h.identity.id)).rejects.toMatchObject(unavailable);
    expect(credentialReads).toBe(0);
    expect(h.a.counts()).toEqual(before);
    expectUntouched(h);
  });

  it("pins mint destination before credential loading even when connection changes before dispatch", async () => {
    const h = await fixture();
    const gate = createBarrier();
    const get = h.repos.credentials.get;
    let first = true;
    h.repos.credentials.get = async (id) => {
      if (first) {
        first = false;
        await gate.block();
      }
      return get(id);
    };
    const mint = h.tokens.get(h.identity.id);
    try {
      await gate.wait();
      await h.switchToB();
    } finally {
      gate.release();
    }
    expect(typeof (await mint)).toBe("string");
    await expect(h.tokens.get(h.identity.id)).rejects.toMatchObject(unavailable);
    expect(h.a.counts()).toMatchObject({ requests: 1, passwords: 1, mutations: 0 });
    expectUntouched(h);
  });

  it("denies delayed storage execution after binding without mutating either server", async () => {
    const h = await fixture();
    const storage = await h.storageFactory(h.identity.id);
    await h.tokens.get(h.identity.id);
    const before = h.a.counts();
    await h.switchToB();
    await expect(
      storage.upload(SHARED_PATH, new TextEncoder().encode("replacement")),
    ).rejects.toMatchObject(unavailable);
    await expect(h.storageFactory(h.identity.id)).rejects.toMatchObject(unavailable);
    expect(h.a.counts()).toEqual(before);
    expectUntouched(h);
  });

  it("probes directory on Server A and denies after switching provider without touching Server B", async () => {
    const h = await fixture();
    const storage = await h.storageFactory(h.identity.id);
    if (!storage.probeDirectoryRead) throw new Error("probeDirectoryRead not implemented");
    await expect(storage.probeDirectoryRead("/")).resolves.toBeUndefined();
    expect(h.a.counts().bearers).toBeGreaterThan(0);
    const before = h.a.counts();
    await h.switchToB();
    await expect(storage.probeDirectoryRead("/")).rejects.toMatchObject(unavailable);
    expect(h.a.counts()).toEqual(before);
    expectUntouched(h);
  });

  it("keeps an admitted mutation on A after token resolution and preserves B's same path", async () => {
    const h = await fixture();
    const gate = createBarrier();
    const factory = createIdentityStorageFactory({
      clientForIdentity: h.clientForIdentity,
      tokenSource: {
        withToken: (id, fn) =>
          h.tokens.withToken(id, async (token) => {
            await gate.block();
            return fn(token);
          }),
      },
    });
    const storage = await factory(h.identity.id);
    const write = storage.upload(SHARED_PATH, new TextEncoder().encode("A changed"));
    try {
      await gate.wait();
      await h.switchToB();
    } finally {
      gate.release();
    }
    await write;
    expect(h.a.counts()).toMatchObject({ passwords: 1, bearers: 1, mutations: 1 });
    expectUntouched(h);
    // Positive controls prove both servers are live, accept distinct credentials, and own the same path.
    for (const [server, content] of [
      [h.a, "A changed"],
      [h.b, "content from B"],
    ] as const) {
      const token = await server.client.login({ username: USERNAME, password: server.password });
      const download = await server.client.user(token.accessToken).download(SHARED_PATH);
      expect(await new Response(download.body).text()).toBe(content);
      expect(server.counts().foreignCredentials).toBe(0);
    }
  });

  it("rejects initial credential verification if the connection changes during the HTTP login", async () => {
    const h = await providerFixture();
    onTestFinished(() => h.close());
    const gate = h.a.pause("GET", "/api/v2/user/token");
    const verification = verifyAccountCredentials(
      {
        repos: h.repos,
        connectionStore: h.connections,
        clientForBaseUrl: h.clientForBaseUrl,
        limiter: createLoginLimiter({ clock: h.clock }),
      },
      { username: USERNAME, password: h.a.password, ip: "127.0.0.1" },
    );
    const rejection = expect(verification).rejects.toMatchObject({ kind: "unauthorized" });
    try {
      await gate.wait();
      await h.switchToB();
    } finally {
      gate.release();
    }
    await rejection;
    expect(await h.repos.identities.listAll()).toEqual([]);
    expect(h.a.counts()).toMatchObject({ passwords: 1, bearers: 0 });
    expectUntouched(h);
  });
});

describe("composed native identity and API-token provider binding", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  beforeAll(async () => {
    postgres = await startPostgres();
    const db = createDb(postgres.connectionString);
    try {
      await migrate(db.db);
    } finally {
      await db.close();
    }
  });
  afterAll(async () => postgres?.stop());

  async function composedFixture() {
    const h = await composedProviderFixture(postgres.connectionString);
    onTestFinished(() => h.close());
    const login = await h.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ username: USERNAME, password: h.a.password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("login did not create a session cookie");
    const me = MeResponse.parse(await login.json());
    const response = await h.app.request("/api/v1/account/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, cookie },
      body: JSON.stringify({ name: "binding-test", identityId: me.activeIdentityId }),
    });
    expect(response.status).toBe(201);
    const { token } = CreateApiTokenResponse.parse(await response.json());
    // The selected A identity differs from the session's active B identity. Ignoring
    // the native query or API token binding would now hit the wrong provider.
    const providerB = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: h.b.baseUrl });
    const identityB = await h.repos.identities.create({
      accountId: me.account.id,
      providerId: providerB.id,
      externalUsername: USERNAME,
    });
    await h.links.switchActive({
      accountId: me.account.id,
      identityId: identityB.id,
      sessionIdHash: hashSessionId(cookie.slice(cookie.indexOf("=") + 1)),
      at: h.clock(),
    });
    async function switchToB() {
      const result = await h.app.request("/api/v1/admin/connection", {
        method: "PUT",
        headers: { ...jsonHeaders, cookie, [IDENTITY_HEADER]: me.activeIdentityId },
        body: JSON.stringify({ baseUrl: h.b.baseUrl }),
      });
      expect(result.status).toBe(200);
    }
    async function request(mode: "native" | "api-token", mutate = false) {
      if (mode === "native") {
        return h.app.request(
          mutate ? "/api/v1/fs/mkdir" : `/api/v1/fs/list?path=/&identity=${me.activeIdentityId}`,
          {
            method: mutate ? "POST" : "GET",
            headers: {
              ...jsonHeaders,
              cookie,
              ...(mutate ? { [IDENTITY_HEADER]: me.activeIdentityId } : {}),
            },
            ...(mutate ? { body: JSON.stringify({ path: "/created" }) } : {}),
          },
        );
      }
      return h.app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: mutate ? "create_folder" : "list_directory",
            arguments: { path: mutate ? "/created" : "/" },
          },
        }),
      });
    }
    return { ...h, switchToB, request };
  }

  async function expectSuccess(response: Response, mode: "native" | "api-token") {
    expect(response.status).toBe(200);
    const body = await response.json();
    if (mode === "api-token") {
      expect(body).toHaveProperty("result");
      expect(McpResult.parse(body).result.isError).not.toBe(true);
    }
    return body;
  }

  async function expectDenied(response: Response, mode: "native" | "api-token") {
    if (mode === "api-token" && response.status === 200) {
      const body = await response.json();
      expect(McpResult.parse(body).result.isError).toBe(true);
      expect(JSON.stringify(body)).not.toContain("same.txt");
    } else {
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { kind: "upstream_unavailable" } });
    }
  }

  for (const mode of ["native", "api-token"] as const) {
    for (const phase of ["cached", "mint", "retry", "mutation"] as const) {
      it(`${mode}: isolates ${phase} across a live admin connection switch`, async () => {
        const h = await composedFixture();
        const initial = await expectSuccess(await h.request(mode), mode);
        expect(JSON.stringify(initial)).toContain("same.txt");
        const before = h.a.counts();
        if (phase === "cached") {
          await h.switchToB();
        } else {
          if (phase === "mint") h.advance(21 * 60 * 1000);
          const gate = h.a.pause(
            phase === "mutation" ? "POST" : "GET",
            phase === "mint" ? "/api/v2/user/token" : "/api/v2/user/dirs",
            phase === "retry",
          );
          const pending = h.request(mode, phase === "mutation");
          try {
            await gate.wait();
            await h.switchToB();
          } finally {
            gate.release();
          }
          // Native mkdir performs a second storage call to stat the result; that call must deny.
          if (phase === "retry" || (phase === "mutation" && mode === "native"))
            await expectDenied(await pending, mode);
          else await expectSuccess(await pending, mode);
        }
        await expectDenied(await h.request(mode), mode);
        await expectDenied(await h.request(mode, true), mode);
        const after = h.a.counts();
        expect(after.passwords - before.passwords).toBe(phase === "mint" ? 1 : 0);
        expect(after.bearers - before.bearers).toBe(phase === "cached" ? 0 : 1);
        expect(after.mutations - before.mutations).toBe(phase === "mutation" ? 1 : 0);
        expect(after.foreignCredentials).toBe(0);
        // The admin update probes B's health. It never authenticates to B.
        expect(h.b.counts()).toMatchObject({
          passwords: 0,
          bearers: 0,
          mutations: 0,
          foreignCredentials: 0,
        });
      });
    }
  }
});
