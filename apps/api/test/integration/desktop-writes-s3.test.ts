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
import { s3Module } from "@fdrive/s3";
import { startMinio, startPostgres, startSftpgo } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";

/**
 * S3 has no rename and no locks, so it can only ever publish under the default
 * contract: fdrive's per-identity lock, the destination recheck, then a server-side
 * copy that replaces the target object. Nothing is configured on the provider row.
 * Proves a Mac write lands on a real S3 target end to end, and that a writer fdrive
 * does not mediate — a client on the bucket directly — is refused rather than
 * silently overwritten.
 */
it("publishes on S3 with no configuration and refuses an out-of-band change", {
  timeout: 300_000,
}, async () => {
  const postgres = await startPostgres();
  const sftpgo = await startSftpgo({ files: { alice: {} } });
  const minio = await startMinio();
  const stateDir = await mkdtemp(join(tmpdir(), "fdrive-s3-writes-"));
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
  // The same bucket through the S3 API directly, outside every fdrive lock.
  const outside = s3Module.createStorage(
    { id: "outside", baseUrl: minio.baseUrl, config: {} },
    {
      externalUsername: minio.writer.accessKeyId,
      getCredential: async () => ({ password: minio.writer.secretAccessKey }),
      getToken: async () => "",
      invalidateToken: async () => {},
    },
    { fetch: globalThis.fetch },
  );
  const read = async (path: string) => new Response((await outside.download(path)).body).text();
  try {
    const login = await call("/api/v1/auth/login", {
      credential: { username: "alice", password: "alice-password" },
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const provider = (await json("/api/v1/admin/providers", {
      type: "s3",
      label: "Object storage",
      baseUrl: minio.baseUrl,
      config: {},
    })) as { id: string };
    const linked = await call("/api/v1/account/identities", {
      providerId: provider.id,
      credential: { username: minio.writer.accessKeyId, password: minio.writer.secretAccessKey },
      currentCredential: { password: "alice-password" },
    });
    expect(linked.status, await linked.clone().text()).toBe(200);
    cookie = linked.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const me = MeResponse.parse(await linked.json());
    const pairResponse = await call(`${base}/pairings`, { deviceName: "S3 write test" });
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
    const writable = pair.credentials.find((c) => c.location.providerId === provider.id);
    if (!writable) throw Error("Missing S3 write credential");
    // Object storage, no lease, no setting on the row, yet the Mac app is granted writes.
    expect(writable.location.capabilities.create).toBe(true);
    expect(writable.location.readOnly).toBe(false);
    cookie = "";
    bearer = `Bearer ${writable.token}`;

    const publish = async (
      name: string,
      bytes: string,
      item?: ReturnType<typeof DesktopWriteEntry.parse>,
      baseContent?: string,
      parentId = "root",
    ) => {
      const operationId = randomUUID();
      await json(`${base}/uploads`, {
        operationId,
        name,
        parentId,
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

    const created = await publish("object.txt", "first");
    expect(created.status, await created.clone().text()).toBe(200);
    const first = DesktopWriteEntry.parse(
      ((await created.json()) as { item: unknown }).item as object,
    );
    expect(await read("/object.txt")).toBe("first");

    const replaced = await publish("object.txt", "second", first, "first");
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    expect(await read("/object.txt")).toBe("second");
    const second = DesktopWriteEntry.parse(
      ((await replaced.json()) as { item: unknown }).item as object,
    );

    // A folder rename on object storage is a copy of every object under it.
    // Finder issues it as one move, and it must land whole.
    const folderOp = randomUUID();
    const folder = await json(`${base}/folders`, {
      operationId: folderOp,
      parentId: "root",
      name: "reports",
    });
    expect((folder as { state: string }).state).toBe("ready");
    const made = DesktopWriteEntry.parse(
      ((await json(`${base}/operations/${folderOp}/commit`, {})) as { item: unknown })
        .item as object,
    );
    for (const name of ["q1.txt", "q2.txt"]) {
      const created = await publish(name, `${name} body`, undefined, undefined, made.id);
      expect(created.status, await created.clone().text()).toBe(200);
    }
    const renameOp = randomUUID();
    await json(`${base}/moves`, {
      operationId: renameOp,
      itemId: made.id,
      parentId: "root",
      name: "reports-2024",
      base: made.version,
    });
    const renamed = await call(`${base}/operations/${renameOp}/commit`, {});
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await read("/reports-2024/q1.txt")).toBe("q1.txt body");
    expect(await read("/reports-2024/q2.txt")).toBe("q2.txt body");
    await expect(outside.stat("/reports")).rejects.toMatchObject({ kind: "not_found" });

    // A writer fdrive does not mediate changes the object. The next publication must
    // refuse rather than drop it, and the external content must survive untouched.
    await outside.upload("/object.txt", new TextEncoder().encode("written over S3"));
    const refused = await publish("object.txt", "third", second, "second");
    expect(refused.status).toBe(409);
    expect(await read("/object.txt")).toBe("written over S3");
  } finally {
    await composed.close?.();
    await rm(stateDir, { recursive: true, force: true });
    await minio.stop();
    await sftpgo.stop();
    await postgres.stop();
  }
});
