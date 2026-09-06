import type { SftpgoClient } from "@fdrive/sftpgo";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.js";
import type { Connection, ConnectionStore } from "./store.js";

const createSftpgoClientMock = vi.fn();

vi.mock("@fdrive/sftpgo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fdrive/sftpgo")>();
  return {
    ...actual,
    createSftpgoClient: (...args: unknown[]) => createSftpgoClientMock(...args),
  };
});

const { createLazySftpgoClient } = await import("./lazy-sftpgo-client.js");

function buildFakeUnderlyingClient(): SftpgoClient {
  const shares = {
    list: vi.fn().mockResolvedValue(["share-list"]),
    get: vi.fn().mockResolvedValue({ id: "share-1" }),
    create: vi.fn().mockResolvedValue({ id: "share-new" }),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const userApi = {
    list: vi.fn().mockResolvedValue(["entry"]),
    statFile: vi.fn().mockResolvedValue({ size: 1 }),
    download: vi.fn().mockResolvedValue({ status: 200 }),
    upload: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    copy: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    deleteDir: vi.fn().mockResolvedValue(undefined),
    setModifiedAt: vi.fn().mockResolvedValue(undefined),
    zip: vi.fn().mockResolvedValue("zip-stream"),
    profile: vi.fn().mockResolvedValue({ email: "a@b.c" }),
    shares,
  };
  const publicShareApi = {
    list: vi.fn().mockResolvedValue(["public-entry"]),
    download: vi.fn().mockResolvedValue({ status: 200 }),
    zip: vi.fn().mockResolvedValue("public-zip-stream"),
    upload: vi.fn().mockResolvedValue(undefined),
  };

  return {
    login: vi.fn().mockResolvedValue({ accessToken: "tok", expiresAt: new Date() }),
    logout: vi.fn().mockResolvedValue(undefined),
    user: vi.fn().mockReturnValue(userApi),
    publicShare: vi.fn().mockReturnValue(publicShareApi),
  };
}

function buildStore(connection: Connection | null): ConnectionStore {
  return {
    current: vi.fn().mockResolvedValue(connection),
    update: vi.fn(),
  };
}

const CONNECTION_A: Connection = {
  baseUrl: "http://sftpgo-a:8080",
  homeTemplate: "sftpgo:/{username}",
  source: "env",
};

beforeEach(() => {
  createSftpgoClientMock.mockReset();
});

describe("createLazySftpgoClient", () => {
  it("throws setup_required when no connection is configured, for every entry point", async () => {
    const store = buildStore(null);
    const client = createLazySftpgoClient({ store });

    await expect(client.login({ username: "a", password: "b" })).rejects.toMatchObject({
      kind: "setup_required",
    });
    await expect(client.logout("tok")).rejects.toBeInstanceOf(ApiHttpError);
    await expect(client.user("tok").list("/")).rejects.toBeInstanceOf(ApiHttpError);
    await expect(client.publicShare("id").list()).rejects.toBeInstanceOf(ApiHttpError);
  });

  it("builds and caches one underlying client per base URL", async () => {
    const fake = buildFakeUnderlyingClient();
    createSftpgoClientMock.mockReturnValue(fake);
    const store = buildStore(CONNECTION_A);
    const client = createLazySftpgoClient({ store });

    await client.login({ username: "a", password: "b" });
    await client.login({ username: "a", password: "b" });

    expect(createSftpgoClientMock).toHaveBeenCalledTimes(1);
    expect(createSftpgoClientMock).toHaveBeenCalledWith({ baseUrl: CONNECTION_A.baseUrl });
  });

  it("passes a custom fetch through to createSftpgoClient when given", async () => {
    const fake = buildFakeUnderlyingClient();
    createSftpgoClientMock.mockReturnValue(fake);
    const store = buildStore(CONNECTION_A);
    const customFetch = vi.fn() as unknown as typeof globalThis.fetch;
    const client = createLazySftpgoClient({ store, fetch: customFetch });

    await client.login({ username: "a", password: "b" });

    expect(createSftpgoClientMock).toHaveBeenCalledWith({
      baseUrl: CONNECTION_A.baseUrl,
      fetch: customFetch,
    });
  });

  it("delegates login and logout", async () => {
    const fake = buildFakeUnderlyingClient();
    createSftpgoClientMock.mockReturnValue(fake);
    const client = createLazySftpgoClient({ store: buildStore(CONNECTION_A) });

    await client.login({ username: "a", password: "b" });
    expect(fake.login).toHaveBeenCalledWith({ username: "a", password: "b" });

    await client.logout("tok-1");
    expect(fake.logout).toHaveBeenCalledWith("tok-1");
  });

  it("delegates every SftpgoUserApi method", async () => {
    const fake = buildFakeUnderlyingClient();
    createSftpgoClientMock.mockReturnValue(fake);
    const client = createLazySftpgoClient({ store: buildStore(CONNECTION_A) });
    const user = client.user("tok-1");
    const underlyingUser = fake.user("tok-1");

    await user.list("/a");
    expect(underlyingUser.list).toHaveBeenCalledWith("/a");

    await user.statFile("/a");
    expect(underlyingUser.statFile).toHaveBeenCalledWith("/a");

    await user.download("/a", { range: { start: 0 } });
    expect(underlyingUser.download).toHaveBeenCalledWith("/a", { range: { start: 0 } });

    const body = new Uint8Array([1]);
    await user.upload("/a", body, { mkdirParents: true });
    expect(underlyingUser.upload).toHaveBeenCalledWith("/a", body, { mkdirParents: true });

    await user.mkdir("/a", { parents: true });
    expect(underlyingUser.mkdir).toHaveBeenCalledWith("/a", { parents: true });

    await user.move("/a", "/b");
    expect(underlyingUser.move).toHaveBeenCalledWith("/a", "/b");

    await user.copy("/a", "/b");
    expect(underlyingUser.copy).toHaveBeenCalledWith("/a", "/b");

    await user.deleteFile("/a");
    expect(underlyingUser.deleteFile).toHaveBeenCalledWith("/a");

    await user.deleteDir("/a");
    expect(underlyingUser.deleteDir).toHaveBeenCalledWith("/a");

    const modifiedAt = new Date();
    await user.setModifiedAt("/a", modifiedAt);
    expect(underlyingUser.setModifiedAt).toHaveBeenCalledWith("/a", modifiedAt);

    await user.zip(["/a", "/b"]);
    expect(underlyingUser.zip).toHaveBeenCalledWith(["/a", "/b"]);

    await user.profile();
    expect(underlyingUser.profile).toHaveBeenCalled();
  });

  it("delegates every SftpgoUserShares method", async () => {
    const fake = buildFakeUnderlyingClient();
    createSftpgoClientMock.mockReturnValue(fake);
    const client = createLazySftpgoClient({ store: buildStore(CONNECTION_A) });
    const shares = client.user("tok-1").shares;
    const underlyingShares = fake.user("tok-1").shares;

    await shares.list();
    expect(underlyingShares.list).toHaveBeenCalled();

    await shares.get("share-1");
    expect(underlyingShares.get).toHaveBeenCalledWith("share-1");

    const input = { name: "n", scope: "read" as const, paths: ["/a"] };
    await shares.create(input);
    expect(underlyingShares.create).toHaveBeenCalledWith(input);

    await shares.update("share-1", input);
    expect(underlyingShares.update).toHaveBeenCalledWith("share-1", input);

    await shares.remove("share-1");
    expect(underlyingShares.remove).toHaveBeenCalledWith("share-1");
  });

  it("delegates every SftpgoPublicShareApi method", async () => {
    const fake = buildFakeUnderlyingClient();
    createSftpgoClientMock.mockReturnValue(fake);
    const client = createLazySftpgoClient({ store: buildStore(CONNECTION_A) });
    const publicShare = client.publicShare("share-1", "pw");
    const underlyingPublicShare = fake.publicShare("share-1", "pw");

    await publicShare.list("/a");
    expect(underlyingPublicShare.list).toHaveBeenCalledWith("/a");

    await publicShare.download("/a", { range: { start: 0 } });
    expect(underlyingPublicShare.download).toHaveBeenCalledWith("/a", { range: { start: 0 } });

    await publicShare.zip();
    expect(underlyingPublicShare.zip).toHaveBeenCalled();

    const body = new Uint8Array([1]);
    await publicShare.upload("file.txt", body, { contentLength: 1 });
    expect(underlyingPublicShare.upload).toHaveBeenCalledWith("file.txt", body, {
      contentLength: 1,
    });
  });
});
