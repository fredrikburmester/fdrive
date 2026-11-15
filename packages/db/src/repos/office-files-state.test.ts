import { describe, expect, it } from "vitest";
import {
  createMemoryOfficeFileRepo,
  escapeOfficeLike,
  officePathMatches,
} from "./office-files-state.js";

const owner = "00000000-0000-0000-0000-000000000001";
const other = "00000000-0000-0000-0000-000000000002";
const location = { identityId: owner, path: "/folder/file.docx" };
const at = new Date("2026-09-06T12:00:00Z");
const move = {
  from: { identityId: owner, path: "/folder" },
  to: { identityId: owner, path: "/moved" },
  at,
};

describe("memory office registry", () => {
  it("shares durable identity between independent opens and protects returned dates", async () => {
    const repo = createMemoryOfficeFileRepo();
    const [a, b] = await Promise.all([repo.ensure(location), repo.ensure(location)]);
    expect(a).toEqual(b);
    a.createdAt.setFullYear(2000);
    expect(await repo.get(a.id)).toEqual(b);
    expect(await repo.get(other)).toBeNull();
    expect((await repo.ensure({ ...location, identityId: other })).id).not.toBe(a.id);
    expect((await repo.ensure({ ...location, path: "/other" })).id).not.toBe(a.id);
  });
  it("accepts deterministic dependencies and copies their timestamp", async () => {
    const clock = new Date(at);
    const repo = createMemoryOfficeFileRepo({ id: () => owner, now: () => clock });
    const file = await repo.ensure(location);
    expect(file).toEqual({ ...location, id: owner, createdAt: at });
    clock.setFullYear(2000);
    expect(await repo.get(file.id)).toEqual(file);
  });
  it("moves exact files and descendants, replaces conflicts, preserves siblings and owners", async () => {
    const repo = createMemoryOfficeFileRepo();
    const source = await repo.ensure(location);
    const child = await repo.ensure({ ...location, path: "/folder/sub/child.docx" });
    const replaced = await repo.ensure({ ...location, path: "/moved/file.docx" });
    const untouched = await Promise.all([
      repo.ensure({ ...location, path: "/folder-sibling/file.docx" }),
      repo.ensure({ ...location, identityId: other }),
      repo.ensure({ identityId: other, path: "/moved/file.docx" }),
      repo.ensure({ ...location, path: "/moved/unrelated.docx" }),
    ]);
    await repo.movePrefix(move);
    await repo.movePrefix(move);
    expect(await repo.get(source.id)).toEqual({ ...source, path: "/moved/file.docx" });
    expect(await repo.get(child.id)).toEqual({ ...child, path: "/moved/sub/child.docx" });
    expect(await repo.get(replaced.id)).toBeNull();
    for (const file of untouched) expect(await repo.get(file.id)).toEqual(file);
    const renamed = { identityId: owner, path: "/renamed.docx" };
    await repo.movePrefix({
      ...move,
      from: { identityId: owner, path: "/moved/file.docx" },
      to: renamed,
    });
    await repo.movePrefix({ ...move, from: renamed, to: renamed });
    expect(await repo.get(source.id)).toEqual({ ...source, path: "/renamed.docx" });
  });
  it("follows a move into another owner's files, replacing what was there", async () => {
    const repo = createMemoryOfficeFileRepo();
    const file = await repo.ensure(location);
    const replaced = await repo.ensure({ identityId: other, path: "/folder/file.docx" });
    await repo.movePrefix({ from: move.from, to: { identityId: other, path: "/folder" }, at });
    expect(await repo.get(file.id)).toEqual({ ...file, identityId: other });
    expect(await repo.get(replaced.id)).toBeNull();
    expect((await repo.ensure(location)).id).not.toBe(file.id);
  });
  it("deletes an owner's prefixes once and gives recreated paths fresh IDs", async () => {
    const repo = createMemoryOfficeFileRepo();
    const file = await repo.ensure(location);
    const sibling = await repo.ensure({ ...location, path: "/folder2/file.docx" });
    const others = await repo.ensure({ ...location, identityId: other });
    await repo.deletePrefix({ ...location, path: "/folder", at });
    await repo.deletePrefix({ ...location, path: "/folder", at });
    expect(await repo.get(file.id)).toBeNull();
    expect(await repo.get(sibling.id)).toEqual(sibling);
    expect(await repo.get(others.id)).toEqual(others);
    const recreated = await repo.ensure(location);
    expect(recreated.id).not.toBe(file.id);
  });
  it("validates paths without silently normalizing traversal", async () => {
    const repo = createMemoryOfficeFileRepo();
    for (const path of [
      "",
      "/",
      "a",
      "/a/",
      "/a//b",
      "/.",
      "/a/..",
      "/a/./b",
      "/a\0b",
      `/${"x".repeat(256)}`,
      `/${"é".repeat(128)}`,
    ]) {
      await expect(repo.ensure({ ...location, path })).rejects.toThrow(TypeError);
    }
    for (const path of [`/${"x".repeat(255)}`, `/${"é".repeat(127)}`, "/quote'/%_\\/📁"]) {
      expect((await repo.ensure({ ...location, path })).path).toBe(path);
    }
    await expect(repo.ensure({ ...location, identityId: "wrong" })).rejects.toThrow(TypeError);
    await expect(repo.get("wrong")).rejects.toThrow(TypeError);
    await expect(repo.deletePrefix({ ...location, at: new Date(Number.NaN) })).rejects.toThrow(
      TypeError,
    );
    await expect(repo.deletePrefix({ ...location, path: "/", at })).rejects.toThrow(TypeError);
    await expect(repo.movePrefix({ ...move, at: new Date(Number.NaN) })).rejects.toThrow(TypeError);
    for (const [from, to] of [
      ["/a", "/a/b"],
      ["/a/b", "/a"],
    ] as const) {
      await expect(
        repo.movePrefix({
          ...move,
          from: { identityId: owner, path: from },
          to: { identityId: owner, path: to },
        }),
      ).rejects.toThrow("overlap");
    }
    // Nested paths in different owners' files do not overlap.
    await repo.movePrefix({
      from: { identityId: owner, path: "/a" },
      to: { identityId: other, path: "/a/b" },
      at,
    });
    await expect(
      repo.movePrefix({ ...move, to: { identityId: owner, path: "bad" } }),
    ).rejects.toThrow(TypeError);
  });
});

it("matches exact slash-boundary prefixes and escapes all SQL wildcards", () => {
  expect(officePathMatches("/a", "/a")).toBe(true);
  expect(officePathMatches("/a/b", "/a")).toBe(true);
  expect(officePathMatches("/ab", "/a")).toBe(false);
  expect(escapeOfficeLike("a%_\\b")).toBe("a\\%\\_\\\\b");
  expect(escapeOfficeLike("a/b")).toBe("a/b");
});
