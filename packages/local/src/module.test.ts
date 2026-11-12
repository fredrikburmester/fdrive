import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageError, type StorageSession } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, kindOf } from "../test/helpers.js";
import {
  createLocalModule,
  isLocalUsername,
  type LocalUserCheck,
  type LocalUserStatus,
  type LocalUsers,
  probeRoot,
} from "./module.js";

const instance = { id: "p1", baseUrl: "http://local.invalid", config: {} };
const ctx = { fetch: globalThis.fetch };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fdrive-local-module-"));
});

afterEach(async () => {
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
});

function users(
  result: LocalUserCheck["result"] | Error,
  status: LocalUserStatus | Error = "active",
): LocalUsers {
  return {
    verify: vi.fn(async (username: string): Promise<LocalUserCheck> => {
      if (result instanceof Error) throw result;
      // The store keeps names in lower case, as a login may type them in any.
      return result === "ok" ? { result, username: username.toLowerCase() } : { result };
    }),
    status: vi.fn(async () => {
      if (status instanceof Error) throw status;
      return status;
    }),
  };
}

function session(externalUsername: string): StorageSession {
  return {
    externalUsername,
    getCredential: async () => ({}),
    getToken: async () => null,
    invalidateToken: async () => undefined,
  };
}

describe("isLocalUsername", () => {
  it.each(["alice", "Bob.Smith", "c-d_e", "f@example.com", "g~h", "1"])("accepts %s", (name) => {
    expect(isLocalUsername(name)).toBe(true);
  });

  it.each(["", ".hidden", "-dash", "a/b", "..", "a b", "ä", "x".repeat(256)])(
    "refuses %j",
    (name) => {
      expect(isLocalUsername(name)).toBe(false);
    },
  );
});

describe("probeRoot", () => {
  it("accepts a writable folder", async () => {
    expect(await probeRoot(root)).toEqual({ ok: true, detail: expect.any(String) });
  });

  it("refuses a file, a missing path and a read-only folder", async () => {
    await writeFile(join(root, "file"), "x");
    expect((await probeRoot(join(root, "file"))).ok).toBe(false);
    expect((await probeRoot(join(root, "missing"))).ok).toBe(false);
    const readOnly = join(root, "read-only");
    await mkdir(readOnly);
    await chmod(readOnly, 0o500);
    // Root ignores permission bits, so only a normal user can see this one.
    if (process.getuid?.() !== 0) expect((await probeRoot(readOnly)).ok).toBe(false);
    await chmod(readOnly, 0o700);
  });
});

describe("createLocalModule", () => {
  it("describes itself honestly", async () => {
    const module = createLocalModule({ root, users: users("ok") });
    expect(module).toMatchObject({
      type: "local",
      trash: "move",
      shares: "owned",
      deploymentManaged: true,
      capabilities: {
        zip: true,
        setModifiedAt: true,
        atomicMove: true,
        trash: true,
        shares: true,
        office: true,
        index: true,
        scopeMapping: false,
      },
    });
    expect(module.capabilities.shares).toBe(module.shares !== "none");
    expect((await module.probe(instance, ctx)).ok).toBe(true);
    expect(module.indexRootName?.(instance)).toBeNull();
    expect(
      createLocalModule({ root, users: users("ok"), indexRoot: "files" }).indexRootName?.(
        instance,
      ),
    ).toBe("files");
  });

  it("signs in by the stored name, whatever case was typed", async () => {
    const module = createLocalModule({ root, users: users("ok") });
    await expect(
      module.authenticate(instance, { username: "Alice", password: "pw" }, ctx),
    ).resolves.toEqual({ externalUsername: "alice" });
    await expect(
      module.authenticate(
        instance,
        { username: "ALICE", password: "pw" },
        { ...ctx, expectedUsername: "alice" },
      ),
    ).resolves.toEqual({ externalUsername: "alice" });
  });

  it("admits only active users", async () => {
    await expect(
      createLocalModule({ root, users: users("ok") }).admit?.(instance, "alice"),
    ).resolves.toBeUndefined();
    for (const status of ["disabled", "missing"] as const) {
      const module = createLocalModule({ root, users: users("ok", status) });
      expect(await kindOf(Promise.resolve(module.admit?.(instance, "alice")))).toBe("forbidden");
    }
    const down = createLocalModule({ root, users: users("ok", new Error("db down")) });
    expect(await kindOf(Promise.resolve(down.admit?.(instance, "alice")))).toBe(
      "upstream_unavailable",
    );
  });

  it("signs in a user whose password checks out", async () => {
    const store = users("ok");
    const module = createLocalModule({ root, users: store });
    await expect(
      module.authenticate(instance, { username: "alice", password: "pw" }, ctx),
    ).resolves.toEqual({ externalUsername: "alice" });
    expect(store.verify).toHaveBeenCalledWith("alice", "pw");
  });

  it("fills the known username on re-authentication and refuses another", async () => {
    const module = createLocalModule({ root, users: users("ok") });
    const known = { ...ctx, expectedUsername: "alice" };
    await expect(module.authenticate(instance, { password: "pw" }, known)).resolves.toEqual({
      externalUsername: "alice",
    });
    expect(
      await kindOf(module.authenticate(instance, { username: "bob", password: "pw" }, known)),
    ).toBe("unauthorized");
  });

  it.each([
    [{ password: "pw" }],
    [{ username: "alice" }],
    [{ username: "alice", password: "" }],
    [{ username: "../etc", password: "pw" }],
  ])(
    "refuses an incomplete or unsafe credential %j without asking the store",
    async (credential) => {
      const store = users("ok");
      const module = createLocalModule({ root, users: store });
      expect(await kindOf(module.authenticate(instance, credential, ctx))).toBe("unauthorized");
      expect(store.verify).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["invalid", "unauthorized"],
    ["disabled", "forbidden"],
  ] as const)("maps a %s user to %s", async (result, kind) => {
    const module = createLocalModule({ root, users: users(result) });
    const credential = { username: "alice", password: "pw" };
    expect(await kindOf(module.authenticate(instance, credential, ctx))).toBe(kind);
  });

  it("reports a failing user store as unavailable, keeping its own storage errors", async () => {
    const credential = { username: "alice", password: "pw" };
    const down = createLocalModule({ root, users: users(new Error("db down")) });
    expect(await kindOf(down.authenticate(instance, credential, ctx))).toBe("upstream_unavailable");
    const limited = createLocalModule({
      root,
      users: users(new StorageError("rate_limited", "slow down")),
    });
    expect(await kindOf(limited.authenticate(instance, credential, ctx))).toBe("rate_limited");
  });

  it("gives each user their own home under the root", async () => {
    const module = createLocalModule({ root, users: users("ok") });
    const alice = module.createStorage(instance, session("alice"), ctx);
    const bob = module.createStorage(instance, session("bob"), ctx);
    await alice.upload("/note.txt", bytes("alice"));
    expect(await bob.list("/")).toEqual([]);
    expect(await kindOf(bob.statFile("/note.txt"))).toBe("not_found");
    expect((await alice.list("/")).map((entry) => entry.name)).toEqual(["note.txt"]);
  });

  it("refuses to build storage for a name that cannot be a home", () => {
    const module = createLocalModule({ root, users: users("ok") });
    expect(() => module.createStorage(instance, session(".."), ctx)).toThrow(StorageError);
  });
});
