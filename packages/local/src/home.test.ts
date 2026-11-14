import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kindOf } from "../test/helpers.js";
import { createHome } from "./home.js";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-local-home-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createHome", () => {
  it("maps the home's own path to its folder and clamps .. at it", async () => {
    const home = createHome(join(root, "alice"));
    expect(await home.locate("/")).toEqual({ at: join(root, "alice"), path: "/" });
    expect(await home.locate("/a/../b")).toEqual({ at: join(root, "alice", "b"), path: "/b" });
  });

  it("may itself be reached through a link, as the deployment set it up", async () => {
    await mkdir(join(root, "disk", "alice", "docs"), { recursive: true });
    await symlink(join(root, "disk", "alice"), join(root, "alice"));
    const home = createHome(join(root, "alice"));
    expect((await home.locate("/docs")).at).toBe(join(root, "disk", "alice", "docs"));
  });

  it("refuses a link at any segment, one leading nowhere or in a loop too", async () => {
    await mkdir(join(root, "alice", "docs"), { recursive: true });
    await symlink(join(root, "alice", "docs"), join(root, "alice", "alias"));
    await symlink(join(root, "nowhere"), join(root, "alice", "dangling"));
    await symlink(join(root, "alice", "loop"), join(root, "alice", "loop"));
    const home = createHome(join(root, "alice"));
    for (const path of ["/alias", "/alias/new", "/dangling", "/dangling/new", "/loop", "/loop/x"]) {
      expect(await kindOf(home.locate(path)), path).toBe("forbidden");
    }
    expect((await home.locate("/docs/new/deeper")).at).toBe(
      join(root, "alice", "docs", "new", "deeper"),
    );
  });

  it("reaches a shared folder from its owner's home, never creating it", async () => {
    await mkdir(join(root, "alice", "Projects", "plans"), { recursive: true });
    await symlink(join(root, "alice", "Projects"), join(root, "alice", "Linked"));
    const shared = createHome(join(root, "alice", "Projects"), { within: join(root, "alice") });
    expect(await shared.locate("/plans")).toEqual({
      at: join(root, "alice", "Projects", "plans"),
      path: "/plans",
    });
    const linked = createHome(join(root, "alice", "Linked"), { within: join(root, "alice") });
    expect(await kindOf(linked.locate("/"))).toBe("forbidden");
    expect(await kindOf(linked.locate("/plans"))).toBe("forbidden");
    const gone = createHome(join(root, "alice", "Gone"), { within: join(root, "alice") });
    expect(await kindOf(gone.locate("/x"))).toBe("not_found");
    expect(await readdir(join(root, "alice"))).not.toContain("Gone");
  });

  it("refuses a shared folder outside its owner's home", async () => {
    await mkdir(join(root, "alice"));
    const outside = createHome(join(root, "bob"), { within: join(root, "alice") });
    expect(await kindOf(outside.locate("/"))).toBe("forbidden");
  });
});
