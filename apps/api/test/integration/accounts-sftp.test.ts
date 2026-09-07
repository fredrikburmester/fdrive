import { AccountFavoritesResponse, MeResponse, ROUTES } from "@fdrive/contracts";
import { parseHomeTemplate } from "@fdrive/core";
import { createDb, createRepos } from "@fdrive/db";
import { startPostgres, startSftpgo } from "@fdrive/testkit";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSessionId } from "../../src/auth/sessions.js";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { officeActor } from "../../src/office/auth.ts";
import { createResolveTokenPrincipal } from "../../src/tokens/principal.js";
import { generateApiToken, hashApiToken } from "../../src/tokens/token-format.js";
import { createMemoryStorage } from "../fixtures/memory-storage.js";
import { officeHarness } from "../fixtures/office/harness.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const hashCookie = (cookie: string) => hashSessionId(cookie.slice("fdrive_session=".length));
describe("accounts against real PostgreSQL and SFTPGo", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let sftp: Awaited<ReturnType<typeof startSftpgo>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;
  let repos: ReturnType<typeof createRepos>;
  beforeAll(async () => {
    [postgres, sftp] = await Promise.all([
      startPostgres(),
      startSftpgo({
        users: ["alice", "bob", "carol", "dave"].map((username) => ({
          username,
          password: `${username}-pass`,
          permissions: { "/": ["*"] },
        })),
        folders: [],
        files: Object.fromEntries(
          ["alice", "bob", "carol", "dave"].map((username) => [
            username,
            { "/report.txt": `${username} private report` },
          ]),
        ),
      }),
    ]);
    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      SFTPGO_URL: sftp.baseUrl,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    const noop = () => undefined;
    const logger = { info: noop, warn: noop, error: noop } as unknown as Logger;
    composed = await composeApp(config, logger);
    database = createDb(postgres.connectionString);
    repos = createRepos(database.db);
  }, 180000);
  afterAll(async () => {
    await composed?.close();
    await database?.close();
    await sftp?.stop();
    await postgres?.stop();
  }, 180000);
  async function call(
    path: string,
    options: {
      method?: string;
      cookie?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return composed.app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function login(username: string) {
    const response = await call(ROUTES.auth.login, {
      method: "POST",
      body: { username, password: `${username}-pass` },
    });
    expect(response.status).toBe(200);
    return { cookie: cookieFrom(response), me: MeResponse.parse(await response.json()) };
  }
  it("transfers identity metadata, revokes old auth, preserves isolation and unlinks without deleting files", async () => {
    const a = await login("alice");
    const b = await login("bob");
    await repos.accounts.setAdmin(b.me.account.id, true);
    const oldSession = await repos.sessions.getByIdHash(hashCookie(a.cookie), new Date());
    const tag = await repos.tags.create(b.me.account.id, { name: "Bob work", color: "blue" });
    await repos.fileTags.setTags(b.me.activeIdentityId, "/report.txt", [tag.id]);
    await repos.favorites.add(a.me.activeIdentityId, "/report.txt", "file");
    await repos.favorites.add(b.me.activeIdentityId, "/report.txt", "file");
    const raw = generateApiToken();
    await repos.apiTokens.create({
      accountId: b.me.account.id,
      identityId: b.me.activeIdentityId,
      name: "before transfer",
      tokenHash: hashApiToken(raw),
      expiresAt: null,
    });
    const storage = createMemoryStorage();
    const tokenPrincipal = createResolveTokenPrincipal({
      apiTokens: repos.apiTokens,
      identities: repos.identities,
      clock: () => new Date(),
      storageFactory: async () => storage,
    });
    expect(await tokenPrincipal(raw)).not.toBeNull();
    const office = await officeHarness();
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: sftp.baseUrl });
    const officeDeps = {
      ...office.deps,
      repos,
      clock: () => new Date(),
      location: async () => ({
        providerId: provider.id,
        homeTemplate: parseHomeTemplate("sftpgo:/{username}"),
      }),
      storageFactory: async () => storage,
    };
    expect(
      (await officeActor(officeDeps, hashCookie(b.cookie), b.me.activeIdentityId)).identity.id,
    ).toBe(b.me.activeIdentityId);
    const linked = await call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: { username: "bob", password: "bob-pass" },
    });
    expect(linked.status).toBe(200);
    const cookie = cookieFrom(linked);
    const me = MeResponse.parse(await linked.json());
    expect(me.identities).toHaveLength(2);
    expect(me.activeIdentityId).toBe(b.me.activeIdentityId);
    expect(me.isAdmin).toBe(false);
    expect((await repos.sessions.getByIdHash(hashCookie(cookie), new Date()))?.expiresAt).toEqual(
      oldSession?.expiresAt,
    );
    expect((await call(ROUTES.auth.me, { cookie: a.cookie })).status).toBe(401);
    expect((await call(ROUTES.auth.me, { cookie: b.cookie })).status).toBe(401);
    expect(await tokenPrincipal(raw)).toBeNull();
    await expect(
      officeActor(officeDeps, hashCookie(b.cookie), b.me.activeIdentityId),
    ).rejects.toMatchObject({ status: 401 });
    expect((await repos.tags.list(a.me.account.id)).some((row) => row.name === "Bob work")).toBe(
      true,
    );
    const favorites = AccountFavoritesResponse.parse(
      await (await call(ROUTES.account.favorites, { cookie })).json(),
    );
    expect(favorites.items).toHaveLength(2);
    for (const [identityId, username] of [
      [a.me.activeIdentityId, "alice"],
      [b.me.activeIdentityId, "bob"],
    ]) {
      const download = await call(`${ROUTES.fs.download}?identity=${identityId}&path=/report.txt`, {
        cookie,
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(`${username} private report`);
    }
    const unlinked = await call(`${ROUTES.account.identities}/${b.me.activeIdentityId}`, {
      method: "DELETE",
      cookie,
    });
    expect(unlinked.status).toBe(200);
    const remaining = MeResponse.parse(await unlinked.json());
    expect(remaining.activeIdentityId).toBe(a.me.activeIdentityId);
    const after = cookieFrom(unlinked);
    expect(
      (
        await call(`${ROUTES.fs.download}?identity=${b.me.activeIdentityId}&path=/report.txt`, {
          cookie: after,
        })
      ).status,
    ).toBe(403);
    await expect(
      officeActor(officeDeps, hashCookie(after), b.me.activeIdentityId),
    ).rejects.toMatchObject({ status: 401 });
    const standalone = await login("bob");
    expect(standalone.me.account.id).not.toBe(a.me.account.id);
    expect(standalone.me.isAdmin).toBe(false);
    expect(
      await (
        await call(`${ROUTES.fs.download}?path=/report.txt`, { cookie: standalone.cookie })
      ).text(),
    ).toBe("bob private report");
  });
  it("serializes simultaneous first logins and login/link ownership races", async () => {
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => login("carol")));
    expect(new Set(concurrent.map((row) => row.me.activeIdentityId)).size).toBe(1);
    expect(new Set(concurrent.map((row) => row.me.account.id)).size).toBe(1);
    const d = await login("dave");
    const responses = await Promise.all([
      call(ROUTES.account.identities, {
        method: "POST",
        cookie: d.cookie,
        body: { username: "carol", password: "carol-pass" },
      }),
      ...Array.from({ length: 8 }, () =>
        call(ROUTES.auth.login, {
          method: "POST",
          body: { username: "carol", password: "carol-pass" },
        }),
      ),
    ]);
    expect(responses.every((response) => [200, 401].includes(response.status))).toBe(true);
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: sftp.baseUrl });
    const identity = await repos.identities.findByProviderUsername(provider.id, "carol");
    expect(identity?.accountId).toBe(d.me.account.id);
    for (const response of responses)
      if (response.status === 200) {
        const me = MeResponse.parse(await response.json());
        const session = await repos.sessions.getByIdHash(
          hashCookie(cookieFrom(response)),
          new Date(),
        );
        if (session !== null) expect(session.accountId).toBe(identity?.accountId);
        expect(me.activeIdentityId).toBe(identity?.id);
      }
    expect(
      (await repos.identities.listAll()).filter((row) => row.externalUsername === "carol"),
    ).toHaveLength(1);
  });
});
