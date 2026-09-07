import { describe, expect, it } from "vitest";
import {
  createMemoryOfficeFileRepo,
  escapeOfficeLike,
  officePathMatches,
  validateOfficePath,
} from "./office-files-state.js";

const providerId = "00000000-0000-0000-0000-000000000001";
const otherProvider = "00000000-0000-0000-0000-000000000002";
const location = { providerId, rootName: "root", path: "folder/file.docx" };
const at = new Date("2026-09-06T12:00:00Z");
const move = { providerId, rootName: "root", from: "folder", to: "moved", at };

describe("memory office registry", () => {
  it("shares durable identity between independent opens and protects returned dates", async () => {
    const repo = createMemoryOfficeFileRepo();
    const [a, b] = await Promise.all([repo.ensure(location), repo.ensure(location)]);
    expect(a).toEqual(b);
    a.createdAt.setFullYear(2000);
    expect(await repo.get(a.id)).toEqual(b);
    expect(await repo.get(otherProvider)).toBeNull();
    expect((await repo.ensure({ ...location, providerId: otherProvider })).id).not.toBe(a.id);
    expect((await repo.ensure({ ...location, rootName: "other" })).id).not.toBe(a.id);
    expect((await repo.ensure({ ...location, path: "other" })).id).not.toBe(a.id);
  });
  it("accepts deterministic dependencies and copies their timestamp", async () => {
    const clock = new Date(at);
    const repo = createMemoryOfficeFileRepo({ id: () => providerId, now: () => clock });
    const file = await repo.ensure(location);
    expect(file).toEqual({ ...location, id: providerId, createdAt: at });
    clock.setFullYear(2000);
    expect(await repo.get(file.id)).toEqual(file);
  });
  it("moves exact files and descendants, replaces conflicts, preserves siblings and scopes", async () => {
    const repo = createMemoryOfficeFileRepo();
    const source = await repo.ensure(location);
    const child = await repo.ensure({ ...location, path: "folder/sub/child.docx" });
    const replaced = await repo.ensure({ ...location, path: "moved/file.docx" });
    const untouched = await Promise.all([
      repo.ensure({ ...location, path: "folder-sibling/file.docx" }),
      repo.ensure({ ...location, rootName: "other" }),
      repo.ensure({ ...location, providerId: otherProvider }),
      repo.ensure({ ...location, path: "moved/unrelated.docx" }),
    ]);
    await repo.movePrefix(move);
    await repo.movePrefix(move);
    expect(await repo.get(source.id)).toEqual({ ...source, path: "moved/file.docx" });
    expect(await repo.get(child.id)).toEqual({ ...child, path: "moved/sub/child.docx" });
    expect(await repo.get(replaced.id)).toBeNull();
    for (const file of untouched) expect(await repo.get(file.id)).toEqual(file);
    await repo.movePrefix({ ...move, from: "moved/file.docx", to: "renamed.docx" });
    await repo.movePrefix({ ...move, from: "renamed.docx", to: "renamed.docx" });
    expect(await repo.get(source.id)).toEqual({ ...source, path: "renamed.docx" });
    await repo.movePrefix({ ...move, from: "", to: "" });
  });
  it("deletes scoped prefixes once and gives recreated paths fresh IDs", async () => {
    const repo = createMemoryOfficeFileRepo();
    const file = await repo.ensure(location);
    const sibling = await repo.ensure({ ...location, path: "folder2/file.docx" });
    const otherRoot = await repo.ensure({ ...location, rootName: "other" });
    const other = await repo.ensure({ ...location, providerId: otherProvider });
    await repo.deletePrefix({ ...location, path: "folder", at });
    await repo.deletePrefix({ ...location, path: "folder", at });
    expect(await repo.get(file.id)).toBeNull();
    expect(await repo.get(sibling.id)).toEqual(sibling);
    expect(await repo.get(otherRoot.id)).toEqual(otherRoot);
    expect(await repo.get(other.id)).toEqual(other);
    const recreated = await repo.ensure(location);
    expect(recreated.id).not.toBe(file.id);
    await repo.deletePrefix({ ...location, path: "", at });
    expect(await repo.get(recreated.id)).toBeNull();
    expect(await repo.get(sibling.id)).toBeNull();
    expect(await repo.get(other.id)).toEqual(other);
  });
  it("validates paths without silently normalizing traversal", async () => {
    const repo = createMemoryOfficeFileRepo();
    for (const path of [
      "",
      "/a",
      "a/",
      "a//b",
      ".",
      "a/..",
      "a/./b",
      "a\0b",
      "x".repeat(256),
      "é".repeat(128),
    ]) {
      await expect(repo.ensure({ ...location, path })).rejects.toThrow(TypeError);
    }
    for (const path of ["x".repeat(255), "é".repeat(127), "quote'/%_\\/📁"]) {
      expect((await repo.ensure({ ...location, path })).path).toBe(path);
    }
    await expect(repo.ensure({ ...location, providerId: "wrong" })).rejects.toThrow(TypeError);
    await expect(repo.get("wrong")).rejects.toThrow(TypeError);
    for (const rootName of ["", "a\0b"])
      await expect(repo.ensure({ ...location, rootName })).rejects.toThrow(TypeError);
    await expect(repo.deletePrefix({ ...location, at: new Date(Number.NaN) })).rejects.toThrow(
      TypeError,
    );
    await expect(repo.movePrefix({ ...move, at: new Date(Number.NaN) })).rejects.toThrow(TypeError);
    for (const [from, to] of [
      ["a", "a/b"],
      ["a/b", "a"],
      ["", "a"],
      ["a", ""],
    ] as const) {
      await expect(repo.movePrefix({ ...move, from, to })).rejects.toThrow("overlap");
    }
    await expect(repo.movePrefix({ ...move, to: "/bad" })).rejects.toThrow(TypeError);
  });
});

it("matches exact slash-boundary prefixes and escapes all SQL wildcards", () => {
  expect(officePathMatches("a", "a")).toBe(true);
  expect(officePathMatches("a/b", "a")).toBe(true);
  expect(officePathMatches("ab", "a")).toBe(false);
  expect(officePathMatches("a", "")).toBe(true);
  expect(escapeOfficeLike("a%_\\b")).toBe("a\\%\\_\\\\b");
  expect(escapeOfficeLike("a/b")).toBe("a/b");
  expect(() => validateOfficePath("", true)).not.toThrow();
});
