import { createDb, createIdentityLinksRepo, createRepos, type Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createSftpgoClient } from "@fdrive/sftpgo";
import pino from "pino";
import { KEY_ID, seal } from "../../../src/auth/crypto.js";
import { createIdentityClientResolver } from "../../../src/auth/provider-client.ts";
import { createIdentityStorageFactory } from "../../../src/auth/storage-factory.ts";
import { createTokenSource } from "../../../src/auth/token-source.js";
import { composeApp } from "../../../src/composition.js";
import { loadConfig } from "../../../src/config.js";
import { createConnectionStore } from "../../../src/connection/store.js";
import { startProviderServer, USERNAME } from "./provider-binding-server.ts";

export async function providerFixture(repos: Repos = createMemoryRepos()) {
  let now = Date.parse("2026-09-08T12:00:00Z");
  const clock = () => new Date(now);
  const a = await startProviderServer("A", clock);
  let b: Awaited<ReturnType<typeof startProviderServer>>;
  try {
    b = await startProviderServer("B", clock);
  } catch (error) {
    await a.close();
    throw error;
  }
  try {
    const master = Buffer.alloc(32, 19);
    const connections = createConnectionStore({
      settings: repos.settings,
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock,
    });
    await connections.update({ baseUrl: a.baseUrl });
    const clientForBaseUrl = (baseUrl: string) =>
      createSftpgoClient({ baseUrl, fetch: globalThis.fetch });
    const clientForIdentity = createIdentityClientResolver({
      ...repos,
      connections,
      clientForBaseUrl,
    });
    const tokenDeps = { repos, master, clock, clientForIdentity };
    const tokens = createTokenSource(tokenDeps);
    const storageFactory = createIdentityStorageFactory({ clientForIdentity, tokenSource: tokens });
    return {
      a,
      b,
      repos,
      clock,
      master,
      connections,
      clientForBaseUrl,
      clientForIdentity,
      tokenDeps,
      tokens,
      storageFactory,
      advance(milliseconds: number) {
        now += milliseconds;
      },
      async seedIdentity() {
        const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: a.baseUrl });
        const account = await repos.accounts.create({ displayName: USERNAME });
        const identity = await repos.identities.create({
          accountId: account.id,
          providerId: provider.id,
          externalUsername: USERNAME,
        });
        await repos.credentials.put({
          identityId: identity.id,
          keyId: KEY_ID,
          ciphertext: seal(
            master,
            new TextEncoder().encode(JSON.stringify({ password: a.password })),
            identity.id,
          ),
        });
        return identity;
      },
      switchToB: () => connections.update({ baseUrl: b.baseUrl }),
      async close() {
        await Promise.all([a.close(), b.close()]);
      },
    };
  } catch (error) {
    await Promise.all([a.close(), b.close()]);
    throw error;
  }
}

export async function composedProviderFixture(connectionString: string) {
  const database = createDb(connectionString);
  const h = await providerFixture(createRepos(database.db)).catch(async (error: unknown) => {
    await database.close();
    throw error;
  });
  try {
    const config = loadConfig({
      DATABASE_URL: connectionString,
      FDRIVE_MASTER_KEY: h.master.toString("base64"),
      FDRIVE_ADMIN_USERS: USERNAME,
      FDRIVE_MCP_WRITES: "true",
    });
    // No fetch injection: composition and every bound client use the real network transport.
    const composed = await composeApp(config, pino({ level: "silent" }), h.clock);
    return {
      ...h,
      app: composed.app,
      links: createIdentityLinksRepo(database.db),
      async close() {
        await composed.close();
        await h.close();
        await database.close();
      },
    };
  } catch (error) {
    await h.close();
    await database.close();
    throw error;
  }
}
