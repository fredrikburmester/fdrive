import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkThumbnailBytes } from "./thumbnails-walk.js";

describe("walkThumbnailBytes", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fdrive-thumbs-walk-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sums file sizes across nested directories", async () => {
    await mkdir(join(dir, "ab"), { recursive: true });
    await writeFile(join(dir, "ab", "one.webp"), Buffer.alloc(10));
    await writeFile(join(dir, "ab", "two.webp"), Buffer.alloc(20));
    await mkdir(join(dir, "cd"), { recursive: true });
    await writeFile(join(dir, "cd", "three.webp"), Buffer.alloc(30));

    const result = await walkThumbnailBytes(dir, 200_000);

    expect(result).toEqual({ bytes: 60, filesWalked: 3 });
  });

  it("returns zero for an empty directory", async () => {
    expect(await walkThumbnailBytes(dir, 200_000)).toEqual({ bytes: 0, filesWalked: 0 });
  });

  it("stops once maxFiles is reached", async () => {
    await writeFile(join(dir, "a.webp"), Buffer.alloc(10));
    await writeFile(join(dir, "b.webp"), Buffer.alloc(10));
    await writeFile(join(dir, "c.webp"), Buffer.alloc(10));

    const result = await walkThumbnailBytes(dir, 2);

    expect(result.filesWalked).toBe(2);
    expect(result.bytes).toBe(20);
  });

  it("returns zero when the directory does not exist", async () => {
    const result = await walkThumbnailBytes(join(dir, "missing"), 200_000);

    expect(result).toEqual({ bytes: 0, filesWalked: 0 });
  });

  it("does not descend into or count a broken symlink", async () => {
    const { symlink } = await import("node:fs/promises");
    await symlink(join(dir, "does-not-exist"), join(dir, "broken.webp"));

    const result = await walkThumbnailBytes(dir, 200_000);

    expect(result).toEqual({ bytes: 0, filesWalked: 0 });
  });
});
