import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  AdminProvidersResponse,
  DESKTOP_API,
  DesktopPairing,
  DesktopPairResult,
  MeResponse,
  ProvidersResponse,
} from "@fdrive/contracts";
import { createDb } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers } from "./helpers/local-storage.ts";

it("pairs two linked logins with isolated streaming reads, validators and revocation", async () => {
  const postgres = await startPostgres();
  const storage = await startLocalStorage({
    users: [
      { username: "alice", password: "alice-password" },
      { username: "bob", password: "bob-password" },
    ],
    files: { alice: { "/same.txt": "alpha" }, bob: { "/same.txt": "bravo" } },
  });
  await seedLocalUsers(postgres.connectionString, storage);
  const config = loadConfig({
    DATABASE_URL: postgres.connectionString,
    FDRIVE_STORAGE_ROOT: storage.root,
    FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    FDRIVE_ADMIN_USERS: "alice",
  });
  const composed = await composeApp(config, pino({ level: "silent" }), () => new Date());
  let cookie = "";
  const request = (route: string, body?: unknown, headers: Record<string, string> = {}) =>
    composed.app.request(route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        "x-requested-with": "fdrive",
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const login = await request("/api/v1/auth/login", {
      credential: { username: "alice", password: "alice-password" },
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const firstMe = MeResponse.parse(await login.json());
    const providerId = firstMe.identities[0]?.providerId ?? "";
    // Bob's login on the same folder, linked to alice's account.
    const linked = await request("/api/v1/account/identities", {
      providerId,
      credential: { username: "bob", password: "bob-password" },
      currentCredential: { password: "alice-password" },
    });
    expect(linked.status).toBe(200);
    cookie = linked.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const me = MeResponse.parse(await linked.json());
    const pair = DesktopPairing.parse(
      await (await request(`${DESKTOP_API}/pairings`, { deviceName: "Integration Mac" })).json(),
    );
    expect(
      (
        await request(`${DESKTOP_API}/pairings/${pair.id}/approve`, {
          identityIds: me.identities.map((identity) => identity.id),
        })
      ).status,
    ).toBe(200);
    const result = DesktopPairResult.parse(
      await (
        await request(`${DESKTOP_API}/pairings/${pair.id}/poll`, { secret: pair.secret })
      ).json(),
    );
    if (result.status !== "connected") throw new Error("Expected connection");
    const a = result.credentials.find(
      (credential) => credential.location.identityId === firstMe.activeIdentityId,
    );
    const b = result.credentials.find(
      (credential) => credential.location.identityId !== firstMe.activeIdentityId,
    );
    if (!a || !b) throw new Error("Expected two isolated locations");
    // A label-only admin patch propagates to both logins, existing credentials and new pairings.
    expect(
      (await request("/api/v1/account/active-identity", { identityId: firstMe.activeIdentityId }))
        .status,
    ).toBe(200);
    const beforeProviders = AdminProvidersResponse.parse(
      await (await request("/api/v1/admin/providers")).json(),
    );
    const beforeTokens = await (await request("/api/v1/account/tokens")).json();
    const renamed = await composed.app.request(`/api/v1/admin/providers/${a.location.providerId}`, {
      method: "PATCH",
      headers: { cookie, "x-requested-with": "fdrive", "content-type": "application/json" },
      body: JSON.stringify({ label: "  Home storage  " }),
    });
    expect(renamed.status).toBe(200);
    const afterProviders = AdminProvidersResponse.parse(
      await (await request("/api/v1/admin/providers")).json(),
    );
    for (const before of beforeProviders.providers) {
      const after = afterProviders.providers.find((row: { id: string }) => row.id === before.id);
      if (!after) throw new Error("Provider disappeared during rename");
      expect(after).toEqual({
        ...before,
        checkedAt: after.checkedAt,
        ...(before.id === a.location.providerId ? { label: "Home storage" } : {}),
      });
    }
    expect(await (await request("/api/v1/account/tokens")).json()).toEqual(beforeTokens);
    const namedMe = MeResponse.parse(await (await request("/api/v1/auth/me")).json());
    expect(namedMe.identities).toEqual(
      me.identities.map((identity) => ({
        ...identity,
        ...(identity.providerId === a.location.providerId ? { providerLabel: "Home storage" } : {}),
      })),
    );
    const publicProviders = ProvidersResponse.parse(
      await (await request("/api/v1/providers")).json(),
    );
    expect(publicProviders.providers.find((row) => row.id === a.location.providerId)?.label).toBe(
      "Home storage",
    );
    expect(
      await (
        await request(`${DESKTOP_API}/location`, undefined, {
          authorization: `Bearer ${a.token}`,
          cookie: "",
        })
      ).json(),
    ).toEqual({ ...a.location, displayName: "Home storage" });
    expect(
      await (
        await request(`${DESKTOP_API}/location`, undefined, {
          authorization: `Bearer ${b.token}`,
          cookie: "",
        })
      ).json(),
    ).toEqual({ ...b.location, displayName: "Home storage" });
    const freshPair = DesktopPairing.parse(
      await (await request(`${DESKTOP_API}/pairings`, { deviceName: "New Mac" })).json(),
    );
    expect(
      (
        await request(`${DESKTOP_API}/pairings/${freshPair.id}/approve`, {
          identityIds: [a.location.identityId],
        })
      ).status,
    ).toBe(200);
    const freshResult = DesktopPairResult.parse(
      await (
        await request(`${DESKTOP_API}/pairings/${freshPair.id}/poll`, { secret: freshPair.secret })
      ).json(),
    );
    expect(freshResult).toMatchObject({
      status: "connected",
      credentials: [{ location: { ...a.location, displayName: "Home storage" } }],
    });
    await request(`${DESKTOP_API}/pairings/${freshPair.id}/cancel`, { secret: freshPair.secret });
    for (const [credential, expected] of [
      [a, "alpha"],
      [b, "bravo"],
    ] as const) {
      const headers = { authorization: `Bearer ${credential.token}`, cookie: "" };
      const listing = await request(`${DESKTOP_API}/entries?path=/`, undefined, headers);
      expect(listing.status).toBe(200);
      expect(await listing.json()).toMatchObject({
        entries: [{ path: "/same.txt", readable: true }],
        nextCursor: null,
      });
      const content = await request(`${DESKTOP_API}/content?path=/same.txt`, undefined, headers);
      expect(await content.text()).toBe(expected);
      const validation = await request(
        `${DESKTOP_API}/versions`,
        { paths: ["/same.txt"] },
        headers,
      );
      expect(await validation.json()).toEqual({
        items: [
          {
            path: "/same.txt",
            size: 5,
            version: createHash("sha256").update(expected).digest("hex"),
          },
        ],
      });
    }
    // Replace bytes outside fdrive, with the same size.
    await writeFile(storage.path("bob", "/same.txt"), "delta");
    expect(
      await (
        await request(
          `${DESKTOP_API}/versions`,
          { paths: ["/same.txt"] },
          { authorization: `Bearer ${b.token}`, cookie: "" },
        )
      ).json(),
    ).toMatchObject({ items: [{ version: createHash("sha256").update("delta").digest("hex") }] });
    expect(
      (
        await request(
          `${DESKTOP_API}/disconnect`,
          {},
          { authorization: `Bearer ${a.token}`, cookie: "" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`${DESKTOP_API}/content?path=/same.txt`, undefined, {
          authorization: `Bearer ${a.token}`,
          cookie: "",
        })
      ).status,
    ).toBe(401);
    expect(
      await (
        await request(`${DESKTOP_API}/content?path=/same.txt`, undefined, {
          authorization: `Bearer ${b.token}`,
          cookie: "",
        })
      ).text(),
    ).toBe("delta");
    // Environment admin rights belong to alice's login, not the linked one.
    expect(
      (await request("/api/v1/account/active-identity", { identityId: firstMe.activeIdentityId }))
        .status,
    ).toBe(200);
    // System > Users will not disable a login of the administrator's own
    // account, so another administrator's change is made in the database.
    const database = createDb(postgres.connectionString);
    await database.pool.query("update app.local_users set disabled = true where username = 'bob'");
    await database.close();
    // A credential whose login the folder no longer admits can still disconnect.
    const desktopHeaders = { authorization: `Bearer ${b.token}`, cookie: "" };
    expect((await request(`${DESKTOP_API}/location`, undefined, desktopHeaders)).status).toBe(403);
    expect((await request(`${DESKTOP_API}/disconnect`, {}, desktopHeaders)).status).toBe(200);
    expect((await request(`${DESKTOP_API}/disconnect`, {}, desktopHeaders)).status).toBe(401);
  } finally {
    await composed.close();
    await storage.stop();
    await postgres.stop();
  }
});
