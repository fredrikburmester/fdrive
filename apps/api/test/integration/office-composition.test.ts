import { createDb, createRepos, migrate } from "@fdrive/db";
import { createFakeSftpgoServer } from "@fdrive/sftpgo";
import { startPostgres } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.ts";
import { loadConfig } from "../../src/config.ts";
import { OFFICE_SETTINGS_KEY } from "../../src/office/settings.ts";
import { officeFixtureUsers } from "../fixtures/office/seeded-users.ts";

it("composes persisted editor admission, advanced policy and explicit server injection", async () => {
  const postgres = await startPostgres();
  const { db, close } = createDb(postgres.connectionString);
  try {
    await migrate(db);
    const provider = await createRepos(db).providers.ensure({
      type: "sftpgo",
      baseUrl: "http://fixture-storage",
    });
    const rules = [
      { providerId: provider.id, username: "alice", path: "/", recursive: true, allow: true },
    ];
    for (const scenario of [
      "settings-allow",
      "configured-allow",
      "injected-deny",
      "injected-allow-configured-deny",
    ] as const) {
      const storage = createFakeSftpgoServer({
        users: [...officeFixtureUsers],
        folders: [],
        files: { alice: {} },
      });
      const config = loadConfig({
        DATABASE_URL: postgres.connectionString,
        SFTPGO_URL: "http://fixture-storage",
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        FDRIVE_PUBLIC_URL: "http://fixture-app",
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
      await createRepos(db).settings.set(OFFICE_SETTINGS_KEY, {
        revision: 1,
        enabled: true,
        appUrl: "http://fixture-app",
        editingEnabled: true,
        editingProviderId: provider.id,
        editorUsernames: ["alice"],
      });
      const composed = await composeApp(config, pino({ enabled: false }), () => new Date(), {
        fetch: storage.fetch,
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
          body: JSON.stringify({ username: "alice", password: "alice-password" }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";")[0];
        if (!cookie) throw new Error("Missing login cookie");
        if (scenario === "settings-allow") {
          const repos = createRepos(db);
          const account = await repos.identities.findByProviderUsername(provider.id, "alice");
          if (!account) throw new Error("Missing fixture identity");
          const staleProvider = await repos.providers.ensure({
            type: "sftpgo",
            baseUrl: "http://previous-storage",
          });
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
          body: JSON.stringify({ parent: "/", name: "new.docx" }),
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
  }
});
