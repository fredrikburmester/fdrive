import { PhotosResponse } from "@fdrive/contracts";
import type { Scope, StorageProvider } from "@fdrive/core";
import type { PhotoDetails, PhotoOptions, PhotoRow } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { PHOTOS_PAGE_SIZE, type PhotoRoutesDeps, registerPhotoRoutes } from "./routes.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

/** Alice's home, and Bob's `Trips` shared with her over her own `/Shared with me/Trips`. */
const SCOPES: readonly Scope[] = [
  { fsPrefix: "/alice", virtualPrefix: "/" },
  { fsPrefix: "/bob/Trips", virtualPrefix: "/Shared with me/Trips" },
];

const DETAILS: PhotoDetails = {
  takenAt: "2024-05-01T14:03:09",
  camera: "Apple iPhone 15 Pro",
  width: 3024,
  height: 4032,
  latitude: 59.5,
  longitude: 18,
};

function row(id: number, path: string, overrides: Partial<PhotoRow> = {}): PhotoRow {
  return {
    id,
    rootId: 1,
    path,
    size: 100,
    mtimeNs: 1_714_572_000_000_000_000n,
    takenAt: null,
    at: "2024-05-01T14:00:00.000000",
    ...overrides,
  };
}

interface BuildOptions {
  readonly scopes?: readonly Scope[] | null;
  readonly rows?: readonly PhotoRow[];
  readonly details?: PhotoDetails | null;
  readonly trashPath?: string;
}

function buildApp(options: BuildOptions = {}) {
  const principal: Principal = {
    accountId: "00000000-0000-4000-8000-000000000001",
    identityId: "00000000-0000-4000-8000-0000000000a1",
    username: "alice",
    storage: {} as StorageProvider,
    isAdmin: false,
  };
  const scopes = options.scopes === undefined ? SCOPES : options.scopes;
  const photos = vi.fn(
    async (_prefixes: unknown, _exts: readonly string[], _limit: number, _opts?: PhotoOptions) => [
      ...(options.rows ?? []),
    ],
  );
  const photoDetails = vi.fn(async (_rootId: number, _path: string) =>
    options.details === undefined ? DETAILS : options.details,
  );
  const deps: PhotoRoutesDeps = {
    indexQueries: { photos, photoDetails },
    resolver: { scopesFor: async () => scopes ?? [] },
    indexed: async () => scopes !== null,
    trashPathForStorage: () => options.trashPath ?? null,
  };
  const app = createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as unknown as Logger,
    version: "1.0.0",
    startedAt: new Date("2024-06-01T00:00:00.000Z"),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerPhotoRoutes(groups, deps),
  });
  return { app, photos, photoDetails };
}

describe("GET /api/v1/photos", () => {
  it("shows the images in the caller's scopes at their own paths, and reads the next page after a cursor", async () => {
    const { app, photos } = buildApp({
      trashPath: "/.Trash",
      rows: [
        row(1, "alice/a.jpg", { takenAt: "2024-05-01T14:03:09", at: "2024-05-01T14:03:09.000000" }),
        row(2, "bob/Trips/b.heic"),
        // Shadowed by the shared folder mounted at the same place in Alice's files.
        row(4, "alice/Shared with me/Trips/c.jpg"),
        // Nobody shared Carol's files with Alice.
        row(5, "carol/d.jpg"),
      ],
    });

    const res = await app.request("/api/v1/photos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      photos: [
        {
          path: "/a.jpg",
          name: "a.jpg",
          size: 100,
          modifiedAt: "2024-05-01T14:00:00.000Z",
          takenAt: "2024-05-01T14:03:09",
        },
        {
          path: "/Shared with me/Trips/b.heic",
          name: "b.heic",
          size: 100,
          modifiedAt: "2024-05-01T14:00:00.000Z",
          takenAt: null,
        },
      ],
      nextCursor: null,
    });
    const [prefixes, exts, limit, opts] = photos.mock.calls[0] ?? [];
    expect(prefixes).toEqual([
      { rootId: 1, fsPrefix: "/alice" },
      { rootId: 1, fsPrefix: "/bob/Trips" },
    ]);
    expect(exts).toEqual(expect.arrayContaining([".jpg", ".heic", ".arw"]));
    expect(limit).toBe(PHOTOS_PAGE_SIZE);
    expect(opts?.exclude?.prefixes).toContainEqual({ rootId: 1, fsPrefix: "/alice/.Trash" });
    expect(opts?.exclude?.prefixes).toContainEqual({
      rootId: 1,
      fsPrefix: "/alice/Shared with me",
    });
    expect(opts?.after).toBeUndefined();

    await app.request("/api/v1/photos?cursor=2024-05-01T14:00:00.000000_42");
    expect(photos.mock.calls[1]?.[3]?.after).toEqual({ at: "2024-05-01T14:00:00.000000", id: 42 });
  });

  it("offers a next page only after a full one", async () => {
    const rows = Array.from({ length: PHOTOS_PAGE_SIZE }, (_, index) =>
      row(index + 1, `alice/${index}.jpg`),
    );
    const { app } = buildApp({ rows });

    const body = PhotosResponse.parse(await (await app.request("/api/v1/photos")).json());

    expect(body.photos).toHaveLength(PHOTOS_PAGE_SIZE);
    expect(body.nextCursor).toBe(`2024-05-01T14:00:00.000000_${PHOTOS_PAGE_SIZE}`);
  });

  it("is empty while the files folder is not indexed", async () => {
    const { app, photos } = buildApp({ scopes: null });

    expect(await (await app.request("/api/v1/photos")).json()).toEqual({
      photos: [],
      nextCursor: null,
    });
    expect(photos).not.toHaveBeenCalled();
  });

  it("refuses a cursor it did not give", async () => {
    const { app } = buildApp();

    expect((await app.request("/api/v1/photos?cursor=yesterday")).status).toBe(400);
  });
});

describe("GET /api/v1/photos/details", () => {
  it("answers an in-scope file's details from its index row", async () => {
    const { app, photoDetails } = buildApp();

    const res = await app.request("/api/v1/photos/details?path=/Shared%20with%20me/Trips/b.jpg");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DETAILS);
    expect(photoDetails).toHaveBeenCalledWith(1, "bob/Trips/b.jpg");
  });

  it("is not found when the file is out of scope, out of sight or not indexed", async () => {
    const outOfScope = buildApp({ scopes: [] });
    expect((await outOfScope.app.request("/api/v1/photos/details?path=/a.jpg")).status).toBe(404);
    expect(outOfScope.photoDetails).not.toHaveBeenCalled();

    // Alice's own folder named `Shared with me` stays out of sight.
    const ownShelf = buildApp();
    const hidden = "/api/v1/photos/details?path=/Shared%20with%20me/Mine/a.jpg";
    expect((await ownShelf.app.request(hidden)).status).toBe(404);
    expect(ownShelf.photoDetails).not.toHaveBeenCalled();

    const unindexed = buildApp({ scopes: null });
    expect((await unindexed.app.request("/api/v1/photos/details?path=/a.jpg")).status).toBe(404);

    const missing = buildApp({ details: null });
    expect((await missing.app.request("/api/v1/photos/details?path=/a.jpg")).status).toBe(404);
  });

  it("refuses a request without a usable path", async () => {
    const { app } = buildApp();

    expect((await app.request("/api/v1/photos/details")).status).toBe(400);
    expect((await app.request("/api/v1/photos/details?path=a%00b")).status).toBe(400);
  });
});
