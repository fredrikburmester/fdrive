import { createHash } from "node:crypto";
import { DESKTOP_API, DesktopPairing, DesktopPairResult, MeResponse } from "@fdrive/contracts";
import { startApacheWebdav, startPostgres, startSftpgo } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";

it("pairs real SFTPGo and Apache WebDAV with isolated streaming reads, validators and revocation", async () => {
  const postgres = await startPostgres();
  const sftpgo = await startSftpgo({ files: { alice: { "/same.txt": "alpha" } } });
  const dav = await startApacheWebdav();
  const config = loadConfig({
    DATABASE_URL: postgres.connectionString,
    SFTPGO_URL: sftpgo.baseUrl,
    FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    FDRIVE_ADMIN_USERS: "alice",
  });
  const composed = await composeApp(config, pino({ level: "silent" }), () => new Date());
  const davHeaders = {
    authorization: `Basic ${Buffer.from(`${dav.credential.username}:${dav.credential.password}`).toString("base64")}`,
  };
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
    expect(
      (
        await fetch(new URL("same.txt", dav.baseUrl), {
          method: "PUT",
          headers: davHeaders,
          body: "bravo",
        })
      ).ok,
    ).toBe(true);
    const login = await request("/api/v1/auth/login", {
      credential: { username: "alice", password: "alice-password" },
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const firstMe = MeResponse.parse(await login.json());
    const providerResponse = await request("/api/v1/admin/providers", {
      type: "webdav",
      label: "Desktop DAV",
      baseUrl: dav.baseUrl,
    });
    expect(providerResponse.status).toBe(200);
    const provider = (await providerResponse.json()) as { id: string };
    const linked = await request("/api/v1/account/identities", {
      providerId: provider.id,
      credential: dav.credential,
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
      (credential) => credential.location.providerId === provider.id,
    );
    if (!a || !b) throw new Error("Expected two isolated locations");
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
    // Replace bytes externally, with the same size and within the provider's timestamp precision.
    expect(
      (
        await fetch(new URL("same.txt", dav.baseUrl), {
          method: "PUT",
          headers: davHeaders,
          body: "delta",
        })
      ).ok,
    ).toBe(true);
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
    // Environment admin rights belong to the original SFTPGo login, not the linked DAV login.
    expect(
      (await request("/api/v1/account/active-identity", { identityId: firstMe.activeIdentityId }))
        .status,
    ).toBe(200);
    const disabled = await composed.app.request(`/api/v1/admin/providers/${provider.id}`, {
      method: "PATCH",
      headers: { cookie, "x-requested-with": "fdrive", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    const desktopHeaders = { authorization: `Bearer ${b.token}`, cookie: "" };
    expect((await request(`${DESKTOP_API}/location`, undefined, desktopHeaders)).status).toBe(502);
    expect((await request(`${DESKTOP_API}/disconnect`, {}, desktopHeaders)).status).toBe(200);
    expect((await request(`${DESKTOP_API}/disconnect`, {}, desktopHeaders)).status).toBe(401);
  } finally {
    await composed.close();
    await dav.stop();
    await sftpgo.stop();
    await postgres.stop();
  }
});
