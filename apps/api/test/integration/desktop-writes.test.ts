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
import { startApacheWebdav, startPostgres, startSftpgo } from "@fdrive/testkit";
import pino from "pino";
import { expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";

it.each(["webdav", "sftpgo"] as const)(
  "publishes complete files under a real %s lease with durable replay and conflict protection",
  async (providerType) => {
    const postgres = await startPostgres();
    const sftpgo = await startSftpgo();
    const qualified =
      providerType === "sftpgo"
        ? await startSftpgo({ enforcedWriteUsers: ["alice"], files: { alice: {} } })
        : undefined;
    const dav = qualified
      ? {
          baseUrl: `${qualified.webdavUrl}/`,
          credential: { username: "alice", password: "alice-password" },
          stop: qualified.stop,
        }
      : await startApacheWebdav();
    const stateDir = await mkdtemp(join(tmpdir(), "fdrive-desktop-test-"));
    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      SFTPGO_URL: sftpgo.baseUrl,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      FDRIVE_ADMIN_USERS: "alice",
      FDRIVE_DESKTOP_STATE_DIR: stateDir,
    });
    let loseNextLease = false;
    const composed = await composeApp(config, pino({ level: "silent" }), () => new Date(), {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (
          loseNextLease &&
          String(input) === `${qualified?.baseUrl}/api/v2/user/fdrive/lease` &&
          init?.method === "POST" &&
          response.ok
        ) {
          loseNextLease = false;
          const lease = ((await response.clone().json()) as { token: string }).token;
          const headers = new Headers(init.headers);
          headers.set("X-Fdrive-Write-Lease", lease);
          const released = await fetch(input, { method: "DELETE", headers });
          expect(released.status).toBe(204);
        }
        return response;
      },
    });
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
    const json = async (path: string, body?: unknown) => {
      const response = await call(path, body);
      const value = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return value;
    };
    const base = "/api/v2/desktop";
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const upstreamHeaders = {
      authorization: `Basic ${Buffer.from(`${dav.credential.username}:${dav.credential.password}`).toString("base64")}`,
    };
    try {
      const login = await call("/api/v1/auth/login", {
        credential: { username: "alice", password: "alice-password" },
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const provider = (await json("/api/v1/admin/providers", {
        type: providerType,
        label: "Qualified native storage",
        baseUrl: qualified?.baseUrl ?? dav.baseUrl,
        config: { desktopWriteMode: qualified ? "fdrive-local-v1" : "apache-webdav-exclusive" },
      })) as { id: string };
      const linked = await call("/api/v1/account/identities", {
        providerId: provider.id,
        credential: dav.credential,
        currentCredential: { password: "alice-password" },
      });
      expect(linked.status, await linked.clone().text()).toBe(200);
      cookie = linked.headers.get("set-cookie")?.split(";")[0] ?? cookie;
      const me = MeResponse.parse(await linked.json());
      const pairResponse = await call(`${base}/pairings`, { deviceName: "Write test" });
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
      if (!writable) throw Error("Missing write credential");
      expect(writable.location.capabilities.create).toBe(true);
      expect(pair.credentials.find((c) => c !== writable)?.location.readOnly).toBe(true);
      cookie = "";
      bearer = `Bearer ${writable.token}`;
      const upload = async (
        name: string,
        bytes: string,
        item?: ReturnType<typeof DesktopWriteEntry.parse>,
      ) => {
        const operationId = randomUUID();
        await json(`${base}/uploads`, {
          operationId,
          name,
          parentId: "root",
          itemId: item?.id,
          base: item ? { ...item.version, content: sha("first") } : null,
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
        return operationId;
      };
      const id = await upload("save.txt", "first");
      // Incoming content is invisible until the explicit commit.
      expect(
        (await fetch(new URL("save.txt", dav.baseUrl), { headers: upstreamHeaders })).status,
      ).toBe(404);
      if (qualified) {
        const login = await fetch(`${qualified.baseUrl}/api/v2/user/token`, {
          headers: upstreamHeaders,
        });
        const jwt = ((await login.json()) as { access_token: string }).access_token;
        const headers = { Authorization: `Bearer ${jwt}` };
        const locked = await fetch(`${qualified.baseUrl}/api/v2/user/fdrive/lease`, {
          method: "POST",
          headers,
        });
        expect(locked.status).toBe(200);
        const lease = ((await locked.json()) as { token: string }).token;
        try {
          expect((await call(`${base}/operations/${id}/commit`, {})).status).toBe(502);
          expect(await json(`${base}/operations/${id}`)).toMatchObject({ state: "ready" });
          expect(
            (await fetch(new URL("save.txt", dav.baseUrl), { headers: upstreamHeaders })).status,
          ).toBe(404);
        } finally {
          await fetch(`${qualified.baseUrl}/api/v2/user/fdrive/lease`, {
            method: "DELETE",
            headers: { ...headers, "X-Fdrive-Write-Lease": lease },
          });
        }
        // Loss between acquisition and the first file request must preserve the
        // same ready operation for retry, rather than return a snapshot conflict.
        loseNextLease = true;
        expect((await call(`${base}/operations/${id}/commit`, {})).status).toBe(502);
        expect(loseNextLease).toBe(false);
        expect(await json(`${base}/operations/${id}`)).toMatchObject({ state: "ready" });
        expect(
          (await fetch(new URL("save.txt", dav.baseUrl), { headers: upstreamHeaders })).status,
        ).toBe(404);
      }
      const result = (await json(`${base}/operations/${id}/commit`, {})) as { item: unknown };
      const original = DesktopWriteEntry.parse(result.item);
      expect(
        await (await fetch(new URL("save.txt", dav.baseUrl), { headers: upstreamHeaders })).text(),
      ).toBe("first");
      expect(await json(`${base}/operations/${id}/commit`, {})).toEqual(result);
      const next = await upload("save.txt", "second", original);
      const saved = (await json(`${base}/operations/${next}/commit`, {})) as {
        item: unknown;
        recoveryId: string;
      };
      expect(DesktopWriteEntry.parse(saved.item).id).toBe(original.id);
      expect(saved.recoveryId).toBe(next);
      expect(
        await (await fetch(new URL("save.txt", dav.baseUrl), { headers: upstreamHeaders })).text(),
      ).toBe("second");
      await json(`${base}/operations/${next}/acknowledge`, {});
      expect(await json(`${base}/operations/${next}`)).toEqual(saved);
      // A stale base may not overwrite a later edit, including identical-length edits.
      const stale = await upload("save.txt", "stale", original);
      const rejected = await call(`${base}/operations/${stale}/commit`, {});
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        error: { details: { code: "version_conflict" } },
      });
      expect(
        await (await fetch(new URL("save.txt", dav.baseUrl), { headers: upstreamHeaders })).text(),
      ).toBe("second");
      const listing = (await json(`${base}/entries?path=/`)) as {
        entries: Array<{ path: string }>;
      };
      expect(listing.entries.map((e) => e.path)).toEqual(["/save.txt"]);
      expect((await call(`${base}/entry?path=/.fdrive-desktop`)).status).toBe(403);
      // Case folding is enforced even when the upstream filesystem is case sensitive.
      const collision = await upload("SAVE.txt", "collision");
      expect((await call(`${base}/operations/${collision}/commit`, {})).status).toBe(409);

      const stat = async (path: string) =>
        DesktopWriteEntry.parse(await json(`${base}/entry?path=${encodeURIComponent(path)}`));
      const move = async (
        item: ReturnType<typeof DesktopWriteEntry.parse>,
        parentId: string,
        name = item.name,
      ) => {
        const operationId = randomUUID();
        await json(`${base}/moves`, {
          operationId,
          itemId: item.id,
          parentId,
          name,
          base: item.version,
        });
        return operationId;
      };
      const commit = async (operationId: string) =>
        DesktopWriteEntry.parse(
          ((await json(`${base}/operations/${operationId}/commit`, {})) as { item: unknown }).item,
        );
      const current = await stat("/save.txt");
      const trashOperation = await move(current, "trash");
      const trashedFile = await commit(trashOperation);
      expect(trashedFile).toMatchObject({ id: current.id, parentId: "trash", trashed: true });
      expect(trashedFile.name.endsWith(".txt")).toBe(true);
      expect((await call(`${base}/entry?path=/save.txt`)).status).toBe(404);
      expect(
        await (await call(`${base}/content?path=${encodeURIComponent(trashedFile.path)}`)).text(),
      ).toBe("second");
      // A separate writer can recreate the original name; restore must preserve both copies.
      expect(
        (
          await fetch(new URL("save.txt", dav.baseUrl), {
            method: "PUT",
            headers: upstreamHeaders,
            body: "peer",
          })
        ).status,
      ).toBe(201);
      const blockedRestore = await move(trashedFile, "root");
      const restoreCollision = await call(`${base}/operations/${blockedRestore}/commit`, {});
      expect(restoreCollision.status, await restoreCollision.text()).toBe(409);
      expect(
        await (await fetch(new URL("save.txt", dav.baseUrl), { headers: upstreamHeaders })).text(),
      ).toBe("peer");
      expect(
        await (await call(`${base}/content?path=${encodeURIComponent(trashedFile.path)}`)).text(),
      ).toBe("second");
      const restoredFile = await commit(await move(trashedFile, "root", "restored.txt"));
      expect(restoredFile).toMatchObject({ id: current.id, path: "/restored.txt", trashed: false });
      // Receipt replay after restoration cannot trash the item a second time.
      expect(await commit(trashOperation)).toEqual(trashedFile);
      expect((await stat("/restored.txt")).id).toBe(current.id);

      for (const path of ["Tree", "Tree/empty", "Tree/nested"]) {
        expect(
          (await fetch(new URL(path, dav.baseUrl), { method: "MKCOL", headers: upstreamHeaders }))
            .status,
        ).toBe(201);
      }
      expect(
        (
          await fetch(new URL("Tree/nested/child.txt", dav.baseUrl), {
            method: "PUT",
            headers: upstreamHeaders,
            body: "child",
          })
        ).status,
      ).toBe(201);
      const tree = await stat("/Tree"),
        child = await stat("/Tree/nested/child.txt");
      const trashTree = await move(tree, "trash");
      // A new deep descendant after prepare is retained by the whole-directory MOVE.
      expect(
        (
          await fetch(new URL("Tree/nested/new.txt", dav.baseUrl), {
            method: "PUT",
            headers: upstreamHeaders,
            body: "new",
          })
        ).status,
      ).toBe(201);
      const trashedTree = await commit(trashTree);
      expect((await stat(`${trashedTree.path}/nested/child.txt`)).id).toBe(child.id);
      expect((await stat(`${trashedTree.path}/empty`)).kind).toBe("dir");
      expect(
        await (
          await call(
            `${base}/content?path=${encodeURIComponent(`${trashedTree.path}/nested/new.txt`)}`,
          )
        ).text(),
      ).toBe("new");
      const trashListing = (await json(`${base}/entries?path=/.fdrive-desktop/trash`)) as {
        entries: unknown[];
      };
      expect(trashListing.entries.map((item) => DesktopWriteEntry.parse(item).id)).toEqual([
        tree.id,
      ]);
      // No permanent-delete endpoint is exposed to desktop credentials.
      expect(
        (
          await call(
            `${base}/entry?path=${encodeURIComponent(trashedTree.path)}`,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(404);
      expect((await commit(await move(trashedTree, "root"))).path).toBe("/Tree");
      expect((await stat("/Tree/nested/child.txt")).id).toBe(child.id);
      expect((await stat("/Tree/empty")).kind).toBe("dir");
      expect(
        await (
          await fetch(new URL("Tree/nested/new.txt", dav.baseUrl), { headers: upstreamHeaders })
        ).text(),
      ).toBe("new");
    } finally {
      await composed.close();
      await dav.stop();
      await sftpgo.stop();
      await postgres.stop();
      await rm(stateDir, { recursive: true, force: true });
    }
  },
  600_000,
);
