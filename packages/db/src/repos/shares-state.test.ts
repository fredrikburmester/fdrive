import { describe, expect, it } from "vitest";
import {
  cloneShareRecord,
  compareShareRecords,
  createMemoryShareRepo,
  parseSharePresentation,
  parseShareScope,
  type ShareInsertInput,
  type ShareOwnedUpdate,
  type ShareUpsertInput,
  shareAdmitsDownload,
  shareListLimit,
  shareStoredValues,
  validateShareId,
  validateShareInsert,
  validateShareOwnedUpdate,
  validateSharePath,
  validateShareUpsert,
} from "./shares-state.js";

const identityId = "00000000-0000-0000-0000-000000000001";
const otherIdentity = "00000000-0000-0000-0000-000000000002";
const at = new Date("2026-09-07T01:00:00Z");
const later = new Date(at.getTime() + 1000);
const input: ShareUpsertInput = {
  identityId,
  sftpgoShareId: "s1",
  name: "Shared",
  description: "",
  scope: "read",
  paths: ["/folder"],
  hasPassword: false,
  expiresAt: null,
  maxDownloads: 0,
  views: 0,
  presentation: "auto",
  updatedAt: at,
  at,
};
const owned: ShareInsertInput = {
  identityId,
  name: "Owned",
  description: "",
  scope: "read",
  paths: ["/folder"],
  expiresAt: null,
  maxDownloads: 0,
  presentation: "auto",
  passwordHash: null,
  at,
};
const ownedUpdate: ShareOwnedUpdate = {
  name: "Owned",
  description: "",
  scope: "read",
  paths: ["/folder"],
  expiresAt: null,
  maxDownloads: 0,
  presentation: "auto",
  at: later,
};

describe("share validation", () => {
  it("accepts pinned boundaries, root and literal percent paths", () => {
    expect(() => validateShareUpsert(input)).not.toThrow();
    expect(() =>
      validateShareUpsert({
        ...input,
        name: "é".repeat(255),
        description: "line one\nline two".repeat(2048),
        sftpgoShareId: "_-aZ19".repeat(42),
        scope: "write",
        maxDownloads: 2147483647,
        paths: Array.from({ length: 1000 }, () => "/"),
        views: 2147483647,
        hasPassword: true,
        expiresAt: later,
        presentation: "gallery",
      }),
    ).not.toThrow();
    for (const path of ["/", "/a", "/a/b", "/%2e%2e/%2f", `/${"x".repeat(4095)}`])
      expect(() => validateSharePath(path)).not.toThrow();
    expect(parseShareScope("read")).toBe("read");
    expect(parseShareScope("write")).toBe("write");
    for (const presentation of ["auto", "list", "gallery", "download"] as const)
      expect(parseSharePresentation(presentation)).toBe(presentation);
    expect(shareListLimit()).toBe(200);
    expect(shareListLimit({})).toBe(200);
    expect(shareListLimit({ limit: 1 })).toBe(1);
    expect(shareListLimit({ limit: 1000 })).toBe(1000);
  });
  it("rejects invalid UUIDs, upstream URLs, names and scopes", () => {
    for (const id of ["", "bad", "00000000-0000-0000-0000-00000000000A"])
      expect(() => validateShareId(id)).toThrow(TypeError);
    for (const sftpgoShareId of [
      "",
      "x".repeat(256),
      "https://host/x",
      "a/b",
      "a?b",
      "a#b",
      "a\0b",
      "..",
      "a\\b",
    ])
      expect(() => validateShareUpsert({ ...input, sftpgoShareId })).toThrow(TypeError);
    for (const name of ["", "x".repeat(256), "bad\0", "bad\n", 1])
      expect(() => validateShareUpsert({ ...input, name } as ShareUpsertInput)).toThrow(TypeError);
    expect(() => parseShareScope("readwrite")).toThrow(TypeError);
    for (const presentation of ["", "Auto", "slideshow", "list "])
      expect(() => parseSharePresentation(presentation)).toThrow(TypeError);
    expect(() =>
      validateShareUpsert({ ...input, presentation: "slideshow" } as unknown as ShareUpsertInput),
    ).toThrow(TypeError);
  });
  it("rejects noncanonical paths and excessive lists", () => {
    for (const path of [
      "",
      "relative",
      "//",
      "/a/",
      "/a//b",
      "/.",
      "/a/../b",
      "/a/./b",
      "/a\\b",
      "/a\n",
      "/a\u007f",
      "/a\u0085",
      `/${"x".repeat(4096)}`,
      1,
    ])
      expect(() => validateSharePath(path as string)).toThrow(TypeError);
    for (const paths of [[], Array.from({ length: 1001 }, () => "/"), "bad"])
      expect(() => validateShareUpsert({ ...input, paths } as ShareUpsertInput)).toThrow(TypeError);
  });
  it("rejects invalid dates, cached counts, flags and list limits", () => {
    for (const views of [-1, 2147483648, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => validateShareUpsert({ ...input, views })).toThrow(TypeError);
    expect(() =>
      validateShareUpsert({ ...input, hasPassword: "password" } as unknown as ShareUpsertInput),
    ).toThrow(TypeError);
    expect(() => validateShareUpsert({ ...input, at: new Date(Number.NaN) })).toThrow(TypeError);
    expect(() =>
      validateShareUpsert({ ...input, expiresAt: "bad" } as unknown as ShareUpsertInput),
    ).toThrow(TypeError);
    for (const limit of [0, -1, 1001, 0.5, Number.NaN])
      expect(() => shareListLimit({ limit })).toThrow(TypeError);
  });
  it("rejects invalid descriptions, limits, update times and password hashes", () => {
    for (const description of [1, null, "x".repeat(65537)])
      expect(() =>
        validateShareUpsert({ ...input, description } as unknown as ShareUpsertInput),
      ).toThrow(TypeError);
    for (const maxDownloads of [-1, 2147483648, 1.5, Number.NaN])
      expect(() => validateShareUpsert({ ...input, maxDownloads })).toThrow(TypeError);
    expect(() => validateShareUpsert({ ...input, updatedAt: new Date(Number.NaN) })).toThrow(
      TypeError,
    );
    expect(() => validateShareInsert(owned)).not.toThrow();
    expect(() => validateShareInsert({ ...owned, passwordHash: "x".repeat(1024) })).not.toThrow();
    for (const passwordHash of ["", "x".repeat(1025), "bad\0", 1])
      expect(() =>
        validateShareInsert({ ...owned, passwordHash } as unknown as ShareInsertInput),
      ).toThrow(TypeError);
    expect(() => validateShareInsert({ ...owned, at: new Date(Number.NaN) })).toThrow(TypeError);
    expect(() => validateShareOwnedUpdate(identityId, identityId, ownedUpdate)).not.toThrow();
    expect(() =>
      validateShareOwnedUpdate(identityId, identityId, { ...ownedUpdate, passwordHash: "" }),
    ).toThrow(TypeError);
    expect(() => validateShareOwnedUpdate("bad", identityId, ownedUpdate)).toThrow(TypeError);
    expect(() => validateShareOwnedUpdate(identityId, "bad", ownedUpdate)).toThrow(TypeError);
  });
});

describe("memory share repository: owned rows", () => {
  it("inserts owned rows without an upstream id and keeps the hash off the record", async () => {
    const repo = createMemoryShareRepo();
    const open = await repo.insert(owned);
    const locked = await repo.insert({ ...owned, name: "Locked", passwordHash: "hash-1" });
    expect(open).toMatchObject({
      identityId,
      sftpgoShareId: null,
      hasPassword: false,
      views: 0,
      createdAt: at,
      updatedAt: at,
    });
    expect(open.id).not.toBe(locked.id);
    expect(locked.hasPassword).toBe(true);
    expect(locked).not.toHaveProperty("passwordHash");
    expect(await repo.get(locked.id)).not.toHaveProperty("passwordHash");
    expect(await repo.passwordHash(open.id)).toBeNull();
    expect(await repo.passwordHash(locked.id)).toBe("hash-1");
    const native = await repo.upsert(input);
    expect(await repo.passwordHash(native.id)).toBeNull();
    expect(await repo.listOwned(identityId)).toHaveLength(3);
  });
  it("updates only owned rows, keeping, replacing or removing the password", async () => {
    const repo = createMemoryShareRepo();
    const row = await repo.insert({ ...owned, passwordHash: "hash-1" });
    const kept = await repo.updateOwned(identityId, row.id, { ...ownedUpdate, name: "Renamed" });
    expect(kept).toEqual({ ...row, name: "Renamed", updatedAt: later });
    expect(await repo.passwordHash(row.id)).toBe("hash-1");
    const replaced = await repo.updateOwned(identityId, row.id, {
      ...ownedUpdate,
      passwordHash: "hash-2",
    });
    expect(replaced?.hasPassword).toBe(true);
    expect(await repo.passwordHash(row.id)).toBe("hash-2");
    const removed = await repo.updateOwned(identityId, row.id, {
      ...ownedUpdate,
      passwordHash: null,
    });
    expect(removed?.hasPassword).toBe(false);
    expect(await repo.passwordHash(row.id)).toBeNull();
    expect(await repo.updateOwned(otherIdentity, row.id, ownedUpdate)).toBeNull();
    const native = await repo.upsert(input);
    expect(await repo.updateOwned(identityId, native.id, ownedUpdate)).toBeNull();
    expect(await repo.get(native.id)).toEqual(native);
    expect(await repo.removeOwned(identityId, row.id)).toBe(true);
    expect(await repo.passwordHash(row.id)).toBeNull();
  });
  it("consumes downloads only while the limit and expiry allow, never for a native row", async () => {
    const repo = createMemoryShareRepo();
    const limited = await repo.insert({ ...owned, maxDownloads: 2 });
    expect((await repo.consume(limited.id, at))?.views).toBe(1);
    expect((await repo.consume(limited.id, at))?.views).toBe(2);
    expect(await repo.consume(limited.id, at)).toBeNull();
    expect((await repo.get(limited.id))?.views).toBe(2);
    const unlimited = await repo.insert(owned);
    for (let i = 1; i <= 3; i++) expect((await repo.consume(unlimited.id, at))?.views).toBe(i);
    const expiring = await repo.insert({ ...owned, expiresAt: later });
    expect((await repo.consume(expiring.id, at))?.views).toBe(1);
    expect(await repo.consume(expiring.id, later)).toBeNull();
    const native = await repo.upsert(input);
    expect(await repo.consume(native.id, at)).toBeNull();
    expect(await repo.consume(otherIdentity, at)).toBeNull();
    expect(shareAdmitsDownload({ expiresAt: null, maxDownloads: 0, views: 5 }, at)).toBe(true);
    await expect(repo.consume("bad", at)).rejects.toThrow(TypeError);
    await expect(repo.consume(limited.id, new Date(Number.NaN))).rejects.toThrow(TypeError);
    await expect(repo.passwordHash("bad")).rejects.toThrow(TypeError);
    await expect(repo.insert({ ...owned, identityId: "bad" })).rejects.toThrow(TypeError);
    await expect(repo.updateOwned(identityId, "bad", ownedUpdate)).rejects.toThrow(TypeError);
  });
});

describe("memory share repository", () => {
  it("atomically upserts one stable UUID and timestamp across concurrent updates", async () => {
    const repo = createMemoryShareRepo();
    const [first, second] = await Promise.all([
      repo.upsert(input),
      repo.upsert({ ...input, name: "Updated", at: later }),
    ]);
    expect(second).toEqual({ ...first, name: "Updated" });
    expect(await repo.get(first.id)).toEqual(second);
    expect(await repo.get(otherIdentity)).toBeNull();
    expect(await repo.listOwned(identityId)).toHaveLength(1);
  });
  it("isolates identity ownership even for identical upstream IDs", async () => {
    const repo = createMemoryShareRepo();
    const first = await repo.upsert(input);
    const second = await repo.upsert({ ...input, identityId: otherIdentity });
    expect(second.id).not.toBe(first.id);
    expect(await repo.getOwned(identityId, first.id)).toEqual(first);
    expect(await repo.getOwned(otherIdentity, first.id)).toBeNull();
    expect(await repo.getOwned(identityId, identityId)).toBeNull();
    expect(await repo.listOwned(identityId)).toEqual([first]);
    expect(await repo.removeOwned(otherIdentity, first.id)).toBe(false);
    expect(await repo.removeOwned(identityId, first.id)).toBe(true);
    expect(await repo.removeOwned(identityId, first.id)).toBe(false);
    expect(await repo.get(first.id)).toBeNull();
    expect(await repo.get(second.id)).toEqual(second);
  });
  it("copies mutable inputs and returned rows and stores no extra runtime fields", async () => {
    const repo = createMemoryShareRepo({ id: () => identityId });
    const paths = ["/folder"];
    const created = new Date(at);
    const expires = new Date(later);
    const extra = {
      ...input,
      paths,
      at: created,
      expiresAt: expires,
      password: "never-store",
      token: "never-store",
    };
    const row = await repo.upsert(extra);
    paths.push("/other");
    created.setFullYear(2000);
    expires.setFullYear(2000);
    expect(row.id).toBe(identityId);
    expect(row).not.toHaveProperty("password");
    expect(row).not.toHaveProperty("token");
    expect(row).not.toHaveProperty("at");
    expect(shareStoredValues(extra)).not.toHaveProperty("password");
    expect(row.paths).toEqual(["/folder"]);
    expect(row.createdAt).toEqual(at);
    expect(row.expiresAt).toEqual(later);
    const expected = cloneShareRecord(row);
    (row.paths as string[]).push("/tampered");
    row.createdAt.setFullYear(2000);
    row.expiresAt?.setFullYear(2000);
    expect(await repo.get(row.id)).toEqual(expected);
    const owned = await repo.getOwned(identityId, row.id);
    owned?.createdAt.setFullYear(2000);
    const listed = await repo.listOwned(identityId);
    listed[0]?.createdAt.setFullYear(2000);
    expect(await repo.get(row.id)).toEqual(expected);
  });
  it("orders newest first with ascending UUID ties and enforces bounded list defaults", async () => {
    let sequence = 0;
    const repo = createMemoryShareRepo({
      id: () => `00000000-0000-0000-0000-${(++sequence).toString(16).padStart(12, "0")}`,
    });
    const first = await repo.upsert(input);
    const tied = await repo.upsert({ ...input, sftpgoShareId: "s2" });
    const newer = await repo.upsert({ ...input, sftpgoShareId: "s3", at: later });
    expect(await repo.listOwned(identityId, { limit: 2 })).toEqual([newer, first]);
    expect(compareShareRecords(first, tied)).toBeLessThan(0);
    expect(compareShareRecords(tied, first)).toBeGreaterThan(0);
    expect(compareShareRecords(first, first)).toBe(0);
    expect(compareShareRecords(first, newer)).toBeGreaterThan(0);
    for (let i = 0; i < 205; i++) await repo.upsert({ ...input, sftpgoShareId: `more-${i}` });
    expect(await repo.listOwned(identityId)).toHaveLength(200);
    expect(await repo.listOwned(identityId, { limit: 1000 })).toHaveLength(208);
  });
  it("validates each operation before access", async () => {
    const repo = createMemoryShareRepo();
    await expect(repo.upsert({ ...input, identityId: "bad" })).rejects.toThrow(TypeError);
    await expect(repo.get("bad")).rejects.toThrow(TypeError);
    await expect(repo.getOwned("bad", identityId)).rejects.toThrow(TypeError);
    await expect(repo.getOwned(identityId, "bad")).rejects.toThrow(TypeError);
    await expect(repo.removeOwned(identityId, "bad")).rejects.toThrow(TypeError);
    await expect(repo.listOwned("bad")).rejects.toThrow(TypeError);
    await expect(repo.listOwned(identityId, { limit: 1001 })).rejects.toThrow(TypeError);
  });
});
