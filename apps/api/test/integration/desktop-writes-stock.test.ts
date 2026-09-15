import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopPairing,
  DesktopWriteEntry,
  DesktopWritePairResult,
  MeResponse,
} from "@fdrive/contracts";
import { startPostgres, startSftpgo } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";

/**
 * One unmodified SFTPGo, the shape a self-hoster actually runs. No lease exists
 * anywhere: publication is qualified only by fdrive's per-identity lock and the
 * destination recheck. Proves the mode is reachable end to end, and that a writer
 * arriving over a protocol fdrive does not mediate — WebDAV, while fdrive drives the
 * REST API — is refused rather than silently overwritten.
 */
it("publishes on stock SFTPGo under verified-optimistic and refuses an out-of-band change", {
  timeout: 300_000,
}, async () => {
  const postgres = await startPostgres();
  const sftpgo = await startSftpgo({ files: { alice: {} } });
  const stateDir = await mkdtemp(join(tmpdir(), "fdrive-stock-writes-"));
  const config = loadConfig({
    DATABASE_URL: postgres.connectionString,
    SFTPGO_URL: sftpgo.baseUrl,
    FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    FDRIVE_ADMIN_USERS: "alice",
    FDRIVE_DESKTOP_STATE_DIR: stateDir,
  });
  const composed = await composeApp(config, pino({ level: "silent" }), () => new Date());
  let cookie = "";
  let bearer = "";
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    composed.app.request(path, {
      method,
      headers: {
        cookie,
        ...(bearer ? { authorization: bearer } : {}),
        "x-requested-with": "fdrive",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (path: string, body?: unknown, method?: string) => {
    const response = await call(path, body, method);
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200);
    return value;
  };
  const base = "/api/v2/desktop";
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const credential = { username: "alice", password: "alice-password" };
  const webdav = (path: string, method: string, body?: string) =>
    fetch(`${sftpgo.webdavUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      },
      ...(body === undefined ? {} : { body }),
    });
  try {
    const login = await call("/api/v1/auth/login", { credential });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    // The deployment's own SFTPGo is already registered; opting into writes is a
    // configuration change on it, not a second endpoint.
    const listed = (await json("/api/v1/admin/providers")) as {
      providers: { id: string; baseUrl: string }[];
    };
    const existing = listed.providers.find((p) => p.baseUrl === sftpgo.baseUrl);
    if (!existing) throw Error("Expected the configured SFTPGo provider");
    await json(
      `/api/v1/admin/providers/${existing.id}`,
      { config: { desktopWriteMode: "verified-optimistic" } },
      "PATCH",
    );
    const linked = await call("/api/v1/account/identities", {
      providerId: existing.id,
      credential,
      currentCredential: { password: credential.password },
    });
    expect(linked.status, await linked.clone().text()).toBe(200);
    cookie = linked.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const me = MeResponse.parse(await linked.json());
    const pairResponse = await call(`${base}/pairings`, { deviceName: "Stock write test" });
    expect(pairResponse.status).toBe(201);
    const pairing = DesktopPairing.parse(await pairResponse.json());
    await json(`/api/v1/desktop/pairings/${pairing.id}/approve`, {
      identityIds: me.identities.map((i) => i.id),
      access: Object.fromEntries(me.identities.map((i) => [i.id, "full"])),
    });
    const pair = DesktopWritePairResult.parse(
      await json(`${base}/pairings/${pairing.id}/poll`, { secret: pairing.secret }),
    );
    if (pair.status !== "connected") throw Error("Expected connected credentials");
    const writable = pair.credentials.find((c) => c.location.providerId === existing.id);
    if (!writable) throw Error("Missing write credential");
    // Stock SFTPGo, no lease, yet the Mac app is granted writes.
    expect(writable.location.capabilities.create).toBe(true);
    cookie = "";
    bearer = `Bearer ${writable.token}`;

    const publish = async (
      name: string,
      bytes: string,
      item?: ReturnType<typeof DesktopWriteEntry.parse>,
      baseContent?: string,
    ) => {
      const operationId = randomUUID();
      await json(`${base}/uploads`, {
        operationId,
        name,
        parentId: "root",
        itemId: item?.id,
        base: item ? { ...item.version, content: sha(baseContent ?? "") } : null,
        size: Buffer.byteLength(bytes),
        sha256: sha(bytes),
      });
      const sent = await composed.app.request(`${base}/operations/${operationId}/content`, {
        method: "PUT",
        headers: {
          authorization: bearer,
          "x-requested-with": "fdrive",
          "content-type": "application/octet-stream",
        },
        body: bytes,
      });
      expect(sent.status, await sent.clone().text()).toBe(200);
      return call(`${base}/operations/${operationId}/commit`, {});
    };

    const created = await publish("stock.txt", "first");
    expect(created.status, await created.clone().text()).toBe(200);
    const first = DesktopWriteEntry.parse(
      ((await created.json()) as { item: unknown }).item as object,
    );
    expect(await (await webdav("/stock.txt", "GET")).text()).toBe("first");

    const replaced = await publish("stock.txt", "second", first, "first");
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    expect(await (await webdav("/stock.txt", "GET")).text()).toBe("second");
    const second = DesktopWriteEntry.parse(
      ((await replaced.json()) as { item: unknown }).item as object,
    );

    // A writer fdrive does not mediate changes the file. The next publication must
    // refuse rather than drop it, and the external content must survive untouched.
    expect((await webdav("/stock.txt", "PUT", "written over WebDAV")).ok).toBe(true);
    const refused = await publish("stock.txt", "third", second, "second");
    expect(refused.status).toBe(409);
    expect(await (await webdav("/stock.txt", "GET")).text()).toBe("written over WebDAV");
  } finally {
    await composed.close?.();
    await rm(stateDir, { recursive: true, force: true });
    await sftpgo.stop();
    await postgres.stop();
  }
});
