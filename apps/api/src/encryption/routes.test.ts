import { ENCRYPTED_FOLDER_MARKER, type EncryptionStatus } from "@fdrive/contracts";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { EncryptionKeyRepo, EncryptionKeys } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import type { FileOperations } from "../files/operations.js";
import { encryptedAccessAllowed, encryptedFoldersOf, guardEncryptedFolders } from "./guard.js";
import { registerEncryptedAccess, registerEncryptionRoutes } from "./routes.js";

const IDENTITY = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const RECIPIENT = `age1${"q".repeat(58)}`;
const OTHER = `age1${"p".repeat(58)}`;
const MARKER = {
  v: 1 as const,
  id: "2f1b8f3e-8c55-4d2b-9a57-1d3b6f0c2a11",
  recipient: OTHER,
  members: [{ recipient: RECIPIENT, key: "YWdl" }],
  mac: `${"A".repeat(43)}=`,
};
const AGE = "age-encryption.org/v1\n-> X25519 body";
const enc = (letter: string) => `fe1-${"a".repeat(46)}${letter}`;

/** The repo in memory, as the integration test pins it on PostgreSQL. */
function memoryKeys(): EncryptionKeyRepo & { tokens: Map<string, string> } {
  let row: EncryptionKeys | null = null;
  const devices = new Map<string, { deviceKey: string; createdAt: Date }>();
  const tokens = new Map<string, string>([["10000000-0000-4000-8000-000000000001", "Mac: Air"]]);
  return {
    tokens,
    async get() {
      return row;
    },
    async create(keys) {
      if (row !== null) return null;
      row = { ...keys, createdAt: new Date(0), updatedAt: new Date(0) };
      return row;
    },
    async setPasswordKey(_identityId, passwordKey) {
      if (row === null) return false;
      row = { ...row, passwordKey };
      return true;
    },
    async remove() {
      const had = row !== null;
      row = null;
      devices.clear();
      return had;
    },
    async devices() {
      return [...devices].map(([tokenId, device]) => ({
        tokenId,
        name: tokens.get(tokenId) ?? "",
        createdAt: device.createdAt,
      }));
    },
    async setDeviceKey(tokenId, _identityId, deviceKey) {
      if (row === null || !tokens.has(tokenId)) return false;
      devices.set(tokenId, { deviceKey, createdAt: new Date(0) });
      return true;
    },
    async deviceKey(tokenId) {
      const device = devices.get(tokenId);
      return row === null || device === undefined
        ? null
        : { recipient: row.recipient, deviceKey: device.deviceKey };
    },
    async removeDevice(_identityId, tokenId) {
      return devices.delete(tokenId);
    },
  };
}

function harness() {
  const storage = guardEncryptedFolders(
    createMemoryStorage({
      "/Docs/a.txt": "plain",
      [`/Private/${ENCRYPTED_FOLDER_MARKER}`]: JSON.stringify(MARKER),
      [`/Private/${enc("b")}`]: AGE,
      [`/Private/${enc("c")}/${enc("d")}`]: AGE,
    }),
  );
  const keys = memoryKeys();
  const revoked: string[] = [];
  const files: Pick<FileOperations, "mkdir"> = {
    mkdir: async (actor, path) => ({ entry: await actor.storage.mkdir(path) }) as never,
  };
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      FDRIVE_STORAGE_ROOT: "/srv/files",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "1.0.0",
    startedAt: new Date(0),
    principalResolver: async () => ({
      accountId: ACCOUNT,
      identityId: IDENTITY,
      username: "alice",
      storage,
      isAdmin: false,
    }),
    registerRoutes: (groups) => {
      registerEncryptedAccess(groups);
      registerEncryptionRoutes(groups, {
        keys,
        tokens: {
          delete: async (id) => {
            revoked.push(id);
          },
        },
        files: files as FileOperations,
        reauthenticate: async (_account, _identity, password) => {
          if (password !== "sign-in") throw new ApiHttpError("unauthorized", "wrong password");
        },
        trustedProxyHops: 0,
      });
      // A route on the allowed list sees inside; one off it does not.
      groups.authed.get("/fs/list", async (c) =>
        c.json({ names: (await storage.list(c.req.query("path") ?? "/")).map((e) => e.name) }),
      );
      groups.v2.get("/desktop/probe", (c) => c.json({ allowed: encryptedAccessAllowed() }));
      groups.authed.get("/fs/zip", async (c) => {
        try {
          await storage.list("/Private");
          return c.json({ reached: true });
        } catch {
          return c.json({ reached: false });
        }
      });
    },
  });
  const desktop = (header?: string) =>
    app.request("/api/v2/desktop/probe", {
      headers: header === undefined ? {} : { "x-fdrive-encrypted-folders": header },
    });
  function call(method: string, path: string, body?: unknown) {
    return app.request(`/api/v1${path}`, {
      method,
      headers: {
        "x-requested-with": "fdrive",
        cookie: "fdrive_session=s",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return { call, desktop, keys, revoked, storage };
}

const setup = {
  signInPassword: "sign-in",
  recipient: RECIPIENT,
  passwordKey: "cGFzcw==",
  recoveryKey: "cmVjb3Zlcnk=",
};

describe("encryption keys", () => {
  it("turns encryption on once, with the sign-in password", async () => {
    const { call } = harness();
    expect(await (await call("GET", "/encryption")).json()).toEqual({ enabled: false });
    expect((await call("POST", "/encryption", { ...setup, signInPassword: "nope" })).status).toBe(
      401,
    );
    const created = await call("POST", "/encryption", setup);
    expect(created.status).toBe(201);
    expect(((await created.json()) as EncryptionStatus).enabled).toBe(true);
    expect((await call("POST", "/encryption", setup)).status).toBe(409);
    const status = (await (await call("GET", "/encryption")).json()) as EncryptionStatus;
    expect(status).toMatchObject({
      enabled: true,
      recipient: RECIPIENT,
      passwordKey: setup.passwordKey,
      recoveryKey: setup.recoveryKey,
      devices: [],
    });
  });

  it("changes the encryption password's copy", async () => {
    const { call, keys } = harness();
    const change = { signInPassword: "sign-in", passwordKey: "bmV3" };
    expect((await call("PUT", "/encryption/password", change)).status).toBe(404);
    await call("POST", "/encryption", setup);
    expect((await call("PUT", "/encryption/password", change)).status).toBe(200);
    expect((await keys.get(IDENTITY))?.passwordKey).toBe("bmV3");
  });

  it("lists Macs and removes one with its token", async () => {
    const { call, keys, revoked } = harness();
    await call("POST", "/encryption", setup);
    const tokenId = "10000000-0000-4000-8000-000000000001";
    await keys.setDeviceKey(tokenId, IDENTITY, "ZGV2aWNl");
    const status = (await (await call("GET", "/encryption")).json()) as EncryptionStatus;
    expect(status.enabled && status.devices).toEqual([
      { id: tokenId, name: "Mac: Air", createdAt: new Date(0).toISOString() },
    ]);
    expect((await call("DELETE", `/encryption/devices/${tokenId}`)).status).toBe(200);
    expect(revoked).toEqual([tokenId]);
    expect((await call("DELETE", `/encryption/devices/${tokenId}`)).status).toBe(404);
  });

  it("resets every key", async () => {
    const { call } = harness();
    await call("POST", "/encryption", setup);
    expect((await call("POST", "/encryption/reset", { signInPassword: "sign-in" })).status).toBe(
      200,
    );
    expect(await (await call("GET", "/encryption")).json()).toEqual({ enabled: false });
  });
});

describe("encrypted folders", () => {
  const folder = { path: "/Secrets", marker: { ...MARKER } };

  it("makes one only for the account's own key, where it may go", async () => {
    const { call, storage } = harness();
    expect((await call("POST", "/encryption/folders", folder)).status).toBe(400);
    await call("POST", "/encryption", setup);
    const foreign = {
      ...folder,
      marker: { ...MARKER, members: [{ recipient: OTHER, key: "YWdl" }] },
    };
    expect((await call("POST", "/encryption/folders", foreign)).status).toBe(400);
    for (const path of [
      "/Private/Inner",
      `/Private/${enc("c")}/Inner`,
      "/.trash/x",
      "/Shared with me/x",
      `/${enc("x")}`,
      `/${ENCRYPTED_FOLDER_MARKER}`,
      "/../",
    ]) {
      expect((await call("POST", "/encryption/folders", { ...folder, path })).status).toBe(400);
    }
    const made = await call("POST", "/encryption/folders", folder);
    expect(made.status).toBe(201);
    expect(await encryptedFoldersOf(storage).isFolder("/Secrets")).toBe(true);
    // A name taken by a folder already there.
    expect((await call("POST", "/encryption/folders", folder)).status).toBe(409);
  });

  it("leaves no empty folder behind when its marker cannot be written", async () => {
    const { call, storage } = harness();
    await call("POST", "/encryption", setup);
    await storage.mkdir("/Taken");
    const writeMarker = vi
      .spyOn(encryptedFoldersOf(storage), "writeMarker")
      .mockRejectedValueOnce(new Error("disk full"));
    expect((await call("POST", "/encryption/folders", { ...folder, path: "/Fresh" })).status).toBe(
      500,
    );
    writeMarker.mockRestore();
    expect((await storage.list("/")).map((entry) => entry.name)).not.toContain("Fresh");
  });

  it("finds the encrypted folder a path is in", async () => {
    const { call } = harness();
    const inside = await call("GET", `/encryption/folder?path=/Private/${enc("c")}`);
    expect(await inside.json()).toEqual({ folder: { path: "/Private", marker: MARKER } });
    expect(await (await call("GET", "/encryption/folder?path=/Docs")).json()).toEqual({
      folder: null,
    });
    expect((await call("GET", "/encryption/folder")).status).toBe(400);
    expect((await call("GET", "/encryption/folder?path=/a%00b")).status).toBe(400);
  });

  it("lists every entry inside an encrypted folder for name search", async () => {
    const { call } = harness();
    const response = await call("GET", "/encryption/entries?path=/Private");
    expect(await response.json()).toEqual({
      entries: [
        { path: `/Private/${enc("b")}`, kind: "file" },
        { path: `/Private/${enc("c")}`, kind: "dir" },
        { path: `/Private/${enc("c")}/${enc("d")}`, kind: "file" },
      ],
      truncated: false,
    });
    expect((await call("GET", "/encryption/entries?path=/Docs")).status).toBe(400);
    expect((await call("GET", "/encryption/entries")).status).toBe(400);
  });

  it("lets a Mac app inside only when it says it encrypts", async () => {
    const { desktop } = harness();
    expect(await (await desktop("1")).json()).toEqual({ allowed: true });
    expect(await (await desktop()).json()).toEqual({ allowed: false });
  });

  it("lets routes on the allowed list inside, and no others", async () => {
    const { call } = harness();
    const listed = (await (await call("GET", "/fs/list?path=/Private")).json()) as {
      names: string[];
    };
    expect(listed.names.sort()).toEqual([enc("b"), enc("c")]);
    expect(await (await call("GET", "/fs/zip")).json()).toEqual({ reached: false });
  });
});
