import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHome } from "./home.js";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-local-home-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createHome", () => {
  it("does not count a sibling sharing the home's name as inside", async () => {
    const home = createHome(join(root, "alice"));
    expect(await home.contains(join(root, "alice"))).toBe(true);
    expect(await home.contains(join(root, "alice", "x"))).toBe(true);
    expect(await home.contains(join(root, "alice2"))).toBe(false);
  });

  it("counts everything as inside a home at the filesystem root", async () => {
    const home = createHome("/");
    expect(await home.contains("/")).toBe(true);
    expect(await home.contains("/etc")).toBe(true);
  });

  it("maps the home's own path to its folder", async () => {
    const home = createHome(join(root, "alice"));
    expect(await home.entry("/")).toBe(join(root, "alice"));
    expect(await home.target("/")).toBe(join(root, "alice"));
    expect(await home.entry("/a/../b")).toBe(join(root, "alice", "b"));
  });
});
