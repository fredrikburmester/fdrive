import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  DESKTOP_API,
  DesktopPairing,
  DesktopPairResult,
  MeResponse,
  SystemStorage,
} from "@fdrive/contracts";
import { createDb } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers } from "./helpers/local-storage.ts";

it("pairs two people's Macs with isolated streaming reads, validators and revocation", async () => {
  const postgres = await startPostgres();
  const storage = await startLocalStorage({
    users: [
      { username: "alice", password: "alice-password" },
      { username: "bob", password: "bob-password" },
    ],
    files: { alice: { "/same.txt": "alpha" }, bob: { "/same.txt": "bravo" } },
  });
  await seedLocalUsers(postgres.connectionString, storage, ["alice"]);
  // An upgraded server: migration 0044 kept its files folder's old row id as the storage id.
  const storageId = "4f1f5e8e-5a1f-4b7e-9d0c-6f1d2a3b4c5d";
  const seeding = createDb(postgres.connectionString);
  await seeding.pool.query("insert into app.settings (key, value) values ('storage.id', $1)", [
    JSON.stringify({ id: storageId }),
  ]);
  await seeding.close();
  const config = loadConfig({
    DATABASE_URL: postgres.connectionString,
    FDRIVE_STORAGE_ROOT: storage.root,
    FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
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
      username: "alice",
      password: "alice-password",
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const aliceCookie = cookie;
    const me = MeResponse.parse(await login.json());
    /** Pairs a Mac for whoever `cookie` signs in, as their browser approves it. */
    async function pairMac(deviceName: string) {
      const pair = DesktopPairing.parse(
        await (await request(`${DESKTOP_API}/pairings`, { deviceName })).json(),
      );
      expect(
        (await request(`${DESKTOP_API}/pairings/${pair.id}/approve`, { access: "read" })).status,
      ).toBe(200);
      const result = DesktopPairResult.parse(
        await (
          await request(`${DESKTOP_API}/pairings/${pair.id}/poll`, { secret: pair.secret })
        ).json(),
      );
      if (result.status !== "connected") throw new Error("Expected connection");
      expect(result.credentials).toHaveLength(1);
      const [credential] = result.credentials;
      if (!credential) throw new Error("Expected a credential");
      return credential;
    }
    const a = await pairMac("Alice's Mac");
    expect(a.location.identityId).toBe(me.identity.id);
    // The Mac compares it with the location it saved, so it must not change.
    expect(a.location.providerId).toBe(storageId);
    // Bob pairs his own Mac from his own browser session.
    const bobLogin = await request("/api/v1/auth/login", {
      username: "bob",
      password: "bob-password",
    });
    expect(bobLogin.status).toBe(200);
    cookie = bobLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const b = await pairMac("Bob's Mac");
    const bOther = await pairMac("Bob's other Mac");
    expect(b.location.identityId).not.toBe(a.location.identityId);
    expect(b.location.providerId).toBe(storageId);
    // A rename of the storage reaches both logins, existing credentials and new pairings.
    cookie = aliceCookie;
    const before = SystemStorage.parse(await (await request("/api/v1/system/storage")).json());
    expect(before).toMatchObject({
      name: "Local folder",
      healthy: true,
    });
    const beforeTokens = await (await request("/api/v1/account/tokens")).json();
    const renamed = await composed.app.request("/api/v1/system/storage", {
      method: "PATCH",
      headers: { cookie, "x-requested-with": "fdrive", "content-type": "application/json" },
      body: JSON.stringify({ name: "  Home storage  " }),
    });
    expect(renamed.status).toBe(200);
    expect(SystemStorage.parse(await renamed.json())).toEqual({ ...before, name: "Home storage" });
    expect(await (await request("/api/v1/account/tokens")).json()).toEqual(beforeTokens);
    const namedMe = MeResponse.parse(await (await request("/api/v1/auth/me")).json());
    expect(namedMe).toEqual({ ...me, storageName: "Home storage" });
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
      (await request(`${DESKTOP_API}/pairings/${freshPair.id}/approve`, { access: "read" })).status,
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
    const revoked = await request(`${DESKTOP_API}/content?path=/same.txt`, undefined, {
      authorization: `Bearer ${a.token}`,
      cookie: "",
    });
    expect(revoked.status).toBe(401);
    // The Mac removes a location whose credential is gone, rather than asking again.
    expect(await revoked.json()).toMatchObject({
      error: { kind: "unauthorized", details: { code: "credential_gone" } },
    });
    expect(
      await (
        await request(`${DESKTOP_API}/content?path=/same.txt`, undefined, {
          authorization: `Bearer ${b.token}`,
          cookie: "",
        })
      ).text(),
    ).toBe("delta");
    // Bob is disabled outside the web, straight in the database.
    const database = createDb(postgres.connectionString);
    await database.pool.query("update app.local_users set disabled = true where username = 'bob'");
    // A credential whose login the folder no longer admits can still disconnect.
    const desktopHeaders = { authorization: `Bearer ${b.token}`, cookie: "" };
    expect((await request(`${DESKTOP_API}/location`, undefined, desktopHeaders)).status).toBe(403);
    expect((await request(`${DESKTOP_API}/disconnect`, {}, desktopHeaders)).status).toBe(200);
    expect((await request(`${DESKTOP_API}/disconnect`, {}, desktopHeaders)).status).toBe(401);
    // A deleted login takes its credentials with it, as migration 0033 deleted logins on
    // storage fdrive no longer serves; the Mac hears that the credential is gone.
    const otherHeaders = { authorization: `Bearer ${bOther.token}`, cookie: "" };
    expect((await request(`${DESKTOP_API}/location`, undefined, otherHeaders)).status).toBe(403);
    await database.pool.query("delete from app.identities where id = $1", [
      bOther.location.identityId,
    ]);
    await database.close();
    const deleted = await request(`${DESKTOP_API}/location`, undefined, otherHeaders);
    expect(deleted.status).toBe(401);
    expect(await deleted.json()).toMatchObject({
      error: { kind: "unauthorized", details: { code: "credential_gone" } },
    });
  } finally {
    await composed.close();
    await storage.stop();
    await postgres.stop();
  }
});
