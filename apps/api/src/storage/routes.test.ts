import { StorageUsageResponse } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { IndexedFile, LocalUser } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { registerStorageUsageRoutes, type StorageUsageRoutesDeps, storageKind } from "./routes.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const SCOPES: readonly Scope[] = [
  { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" },
  { rootName: "files", fsPrefix: "/bob/Projects", virtualPrefix: "/Shared with me/Projects" },
];

function indexed(path: string, size: number): IndexedFile {
  return {
    id: size,
    rootId: 1,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    ext: path.slice(path.lastIndexOf(".")),
    size,
    mtimeNs: 1_700_000_000_000_000_000n,
    sha256: null,
    mime: null,
    textStatus: "done",
    textChars: 0,
    error: null,
    indexedAt: null,
    deletedAt: null,
  };
}

function user(storageLimit: number | null): LocalUser {
  const at = new Date(0);
  return {
    username: "alice",
    passwordHash: "x",
    disabled: false,
    storageLimit,
    createdAt: at,
    updatedAt: at,
  };
}

function buildApp(
  overrides: Partial<StorageUsageRoutesDeps> & { scopes?: readonly Scope[] | null },
) {
  // The scopes are the permission: nothing is read from storage.
  const storage = createMemoryStorage({});
  const principal: Principal = {
    accountId: "account-1",
    identityId: "identity-1",
    username: "alice",
    storage,
    isAdmin: false,
  };
  const { scopes = SCOPES, ...rest } = overrides;
  const deps: StorageUsageRoutesDeps = {
    resolver: {
      verifiedIndexScopes: async () =>
        scopes === null ? { available: false, reason: "no_roots" } : { available: true, scopes },
    },
    indexQueries: {
      rootIdsByName: async () => ({ files: 1 }),
      bytesByExtension: async () => [],
      listFiles: async () => ({ total: 0, files: [] }),
    },
    localUsers: { get: async () => user(null) },
    trashPathForStorage: () => "/.trash",
    ...rest,
  };
  return createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    version: "1.0.0",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerStorageUsageRoutes(groups, deps),
  });
}

async function usage(app: ReturnType<typeof buildApp>) {
  const response = await app.request("/api/v1/storage");
  expect(response.status).toBe(200);
  return StorageUsageResponse.parse(await response.json());
}

describe("storageKind", () => {
  it("sorts extensions into images, videos, audio, documents and the rest", () => {
    expect(["JPG", ".heic", ".arw"].map((ext) => storageKind(ext.toLowerCase()))).toEqual([
      "other",
      "images",
      "images",
    ]);
    expect(storageKind(".MOV")).toBe("videos");
    expect(storageKind(".flac")).toBe("audio");
    for (const ext of [".pdf", ".docx", ".xlsx", ".odt", ".md", ".txt", ".csv", ".epub"]) {
      expect(storageKind(ext), ext).toBe("documents");
    }
    for (const ext of ["", ".zip", ".ts", ".json", ".unknown"]) {
      expect(storageKind(ext), ext).toBe("other");
    }
  });
});

describe("GET /api/v1/storage", () => {
  it("sums the login's own home by kind, against its limit, with its largest files", async () => {
    const bytesByExtension = vi.fn(async () => [
      { ext: ".mp4", bytes: 700 },
      { ext: ".JPG", bytes: 200 },
      { ext: ".pdf", bytes: 90 },
      { ext: "", bytes: 10 },
    ]);
    const listFiles = vi.fn(async () => ({
      total: 3,
      files: [
        indexed("alice/big.mp4", 700),
        // Outside the home scope, so not alice's to see.
        indexed("bob/secret.mov", 300),
        indexed("alice/docs/report.pdf", 90),
      ],
    }));
    const app = buildApp({
      indexQueries: { rootIdsByName: async () => ({ files: 1 }), bytesByExtension, listFiles },
      localUsers: { get: async () => user(5_000) },
    });

    expect(await usage(app)).toEqual({
      indexed: true,
      used: 1_000,
      limit: 5_000,
      kinds: [
        { kind: "images", bytes: 200 },
        { kind: "videos", bytes: 700 },
        { kind: "documents", bytes: 90 },
        { kind: "audio", bytes: 0 },
        { kind: "other", bytes: 10 },
      ],
      largest: [
        { path: "/big.mp4", size: 700, modifiedAt: "2023-11-14T22:13:20.000Z" },
        { path: "/docs/report.pdf", size: 90, modifiedAt: "2023-11-14T22:13:20.000Z" },
      ],
    });
    // Only the home: never a folder someone shares with the login.
    expect(bytesByExtension).toHaveBeenCalledWith([{ rootId: 1, fsPrefix: "/alice" }]);
    const [prefixes, filter, order, limit] = listFiles.mock.calls[0] as unknown as [
      unknown,
      { exclude: { prefixes: unknown[] } },
      string,
      number,
    ];
    expect(prefixes).toEqual([{ rootId: 1, fsPrefix: "/alice" }]);
    expect(filter.exclude.prefixes).toContainEqual({ rootId: 1, fsPrefix: "/alice/.trash" });
    expect([order, limit]).toEqual(["size_desc", 25]);
  });

  it("answers zeros and the limit when the login's files are not indexed", async () => {
    const bytesByExtension = vi.fn();
    const app = buildApp({
      scopes: null,
      localUsers: { get: async () => user(9) },
      indexQueries: {
        rootIdsByName: async () => ({}),
        bytesByExtension,
        listFiles: vi.fn(),
      },
    });
    expect(await usage(app)).toMatchObject({ indexed: false, used: 0, limit: 9, largest: [] });
    expect(bytesByExtension).not.toHaveBeenCalled();

    const noRoot = buildApp({
      indexQueries: { rootIdsByName: async () => ({}), bytesByExtension, listFiles: vi.fn() },
    });
    expect(await usage(noRoot)).toMatchObject({ indexed: false, limit: null });
    const noUser = buildApp({ scopes: null, localUsers: { get: async () => null } });
    expect(await usage(noUser)).toMatchObject({ indexed: false, limit: null });
  });
});
