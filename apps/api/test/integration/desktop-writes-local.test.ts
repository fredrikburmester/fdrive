import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopPairing,
  DesktopWriteEntry,
  DesktopWritePairResult,
  MeResponse,
} from "@fdrive/contracts";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers } from "./helpers/local-storage.ts";

/**
 * The deployment's local folder, the shape a self-hoster actually runs. No lease
 * exists anywhere: publication is qualified only by fdrive's per-identity lock and
 * the destination recheck. Proves the default contract is reachable end to end, and
 * that a writer fdrive does not mediate — a program writing to the folder on disk,
 * as rsync or Syncthing would — is refused rather than silently overwritten.
 */
it("publishes on the local folder with no configuration and refuses an out-of-band change", {
  timeout: 300_000,
}, async () => {
  const postgres = await startPostgres();
  const storage = await startLocalStorage({ files: {} });
  await seedLocalUsers(postgres.connectionString, storage);
  const stateDir = await mkdtemp(join(tmpdir(), "fdrive-local-writes-"));
  const config = loadConfig({
    DATABASE_URL: postgres.connectionString,
    FDRIVE_STORAGE_ROOT: storage.root,
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
  /** Alice's copy of `path` on disk, read and written outside fdrive. */
  const onDisk = storage.path.bind(null, "alice");
  try {
    const login = await call("/api/v1/auth/login", { credential });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    // The deployment's own folder is already registered and needs nothing set on it.
    const listed = (await json("/api/v1/admin/providers")) as {
      providers: { id: string; type: string }[];
    };
    const existing = listed.providers.find((p) => p.type === "local");
    if (!existing) throw Error("Expected the deployment's local folder");
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
    // The local folder, no lease, yet the Mac app is granted writes.
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
    expect(await readFile(onDisk("/stock.txt"), "utf8")).toBe("first");

    const replaced = await publish("stock.txt", "second", first, "first");
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    expect(await readFile(onDisk("/stock.txt"), "utf8")).toBe("second");
    const second = DesktopWriteEntry.parse(
      ((await replaced.json()) as { item: unknown }).item as object,
    );

    // A writer fdrive does not mediate changes the file. The next publication must
    // refuse rather than drop it, and the external content must survive untouched.
    // The refusal here is `checkBase`'s, taken before the serialized section: the
    // change lands before the commit starts. The in-section proofs need a write
    // that lands mid-commit, which `optimistic-publish.test.ts` injects with hooks.
    await writeFile(onDisk("/stock.txt"), "written on disk");
    const refused = await publish("stock.txt", "third", second, "second");
    expect(refused.status).toBe(409);
    expect(await readFile(onDisk("/stock.txt"), "utf8")).toBe("written on disk");
  } finally {
    await composed.close?.();
    await rm(stateDir, { recursive: true, force: true });
    await storage.stop();
    await postgres.stop();
  }
});
