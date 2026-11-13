import { PUBLIC_URL_SETTINGS_KEY } from "@fdrive/contracts";
import { createDb, createRepos, migrate } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.ts";
import { loadConfig } from "../../src/config.ts";
import { OFFICE_SETTINGS_KEY } from "../../src/office/settings.ts";
import { officeFixtureUsers } from "../fixtures/office/seeded-users.ts";
import { seedLocalUsers } from "./helpers/local-storage.ts";

it("composes persisted editor admission, advanced policy and explicit server injection", async () => {
  const postgres = await startPostgres();
  const storage = await startLocalStorage({
    users: officeFixtureUsers.map(({ username, password }) => ({ username, password })),
    files: { alice: {} },
  });
  const { db, close } = createDb(postgres.connectionString);
  try {
    await migrate(db);
    await seedLocalUsers(postgres.connectionString, storage);
    // The row startup pins for `FDRIVE_STORAGE_ROOT`, created first so the
    // Office settings below can name it.
    const provider = await createRepos(db).providers.ensure({ type: "local", baseUrl: "local" });
    const rules = [
      { providerId: provider.id, username: "alice", path: "/", recursive: true, allow: true },
    ];
    for (const scenario of [
      "settings-allow",
      "configured-allow",
      "injected-deny",
      "injected-allow-configured-deny",
    ] as const) {
      const config = loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        FDRIVE_OFFICE_PRODUCT: "onlyoffice",
        FDRIVE_OFFICE_URL: "http://fixture-editor",
        FDRIVE_OFFICE_PUBLIC_URL: "http://fixture-editor",
        FDRIVE_WOPI_URL: "http://fixture-callback/wopi",
        ...(scenario === "configured-allow" || scenario === "injected-allow-configured-deny"
          ? {
              FDRIVE_OFFICE_EDIT_RULES: JSON.stringify(
                scenario === "configured-allow"
                  ? rules
                  : rules.map((rule) => ({ ...rule, allow: false })),
              ),
            }
          : {}),
      });
      await createRepos(db).settings.set(PUBLIC_URL_SETTINGS_KEY, {
        revision: 1,
        url: "http://fixture-app",
      });
      await createRepos(db).settings.set(OFFICE_SETTINGS_KEY, {
        revision: 1,
        enabled: true,
        editingEnabled: true,
        editingProviderId: provider.id,
        editorUsernames: ["alice"],
      });
      const composed = await composeApp(config, pino({ enabled: false }), () => new Date(), {
        ...(scenario === "injected-deny"
          ? { officeCanEdit: async () => false }
          : scenario === "injected-allow-configured-deny"
            ? { officeCanEdit: async () => true }
            : {}),
      });
      try {
        const headers = { "content-type": "application/json", "x-requested-with": "fdrive" };
        const login = await composed.app.request("/api/v1/auth/login", {
          method: "POST",
          headers,
          body: JSON.stringify({
            providerId: provider.id,
            credential: { username: "alice", password: "alice-password" },
          }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";")[0];
        if (!cookie) throw new Error("Missing login cookie");
        if (scenario === "settings-allow") {
          const repos = createRepos(db);
          const account = await repos.identities.findByProviderUsername(provider.id, "alice");
          if (!account) throw new Error("Missing fixture identity");
          // A login on storage an administrator has since switched off.
          const staleProvider = await repos.providers.ensure({
            type: "webdav",
            baseUrl: "http://previous-storage",
          });
          await repos.providers.update(staleProvider.id, { enabled: false });
          const staleIdentity = await repos.identities.create({
            accountId: account.accountId,
            providerId: staleProvider.id,
            externalUsername: "alice",
          });
          const favorites = await composed.app.request("/api/v1/account/favorites", {
            headers: { cookie },
          });
          expect(favorites.status).toBe(200);
          expect(await favorites.json()).toMatchObject({
            items: [],
            unavailableIdentityIds: [staleIdentity.id],
          });
        }
        const created = await composed.app.request("/api/v1/office/documents", {
          method: "POST",
          headers: { ...headers, cookie },
          // One folder serves every scenario, so each creates its own document.
          body: JSON.stringify({ parent: "/", name: `${scenario}.docx` }),
        });
        expect(created.status, scenario).toBe(
          scenario === "injected-deny" || scenario === "injected-allow-configured-deny" ? 403 : 201,
        );
      } finally {
        await composed.close();
      }
    }
  } finally {
    await close();
    await postgres.stop();
    await storage.stop();
  }
});
