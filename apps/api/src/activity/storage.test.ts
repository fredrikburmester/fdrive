import { randomUUID } from "node:crypto";
import { withMoveToTrash } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.js";
import { withRecycleFolderTrash } from "../auth/storage-factory.js";
import type { ActivityRunInput, PersonalActivityService } from "./service.js";
import { activityStorage } from "./storage.js";
import { activityStream } from "./streams.js";
import { captureRecycleReceipt, deleteWithActivityReceipt } from "./trash.js";

function fixture() {
  const inputs: ActivityRunInput[] = [];
  const finish = vi.fn(async (..._args: unknown[]) => ({ id: randomUUID() }));
  const activity = {
    run: vi.fn(async (_principal, input, work, facts = () => input.requested) => {
      inputs.push(input);
      const value = await work();
      await finish(input.action, await facts(value));
      return { value, eventId: randomUUID(), historyPending: false };
    }),
    repo: {
      withPathLock: vi.fn(async (_identity, _path, work) => work()),
      begin: vi.fn(async () => ({ id: randomUUID() })),
      claim: vi.fn(async () => true),
      finish,
      heartbeat: vi.fn(async () => {}),
    },
  } as unknown as PersonalActivityService;
  const principal: Principal = {
    accountId: randomUUID(),
    identityId: randomUUID(),
    username: "alice",
    isAdmin: false,
    storage: createMemoryStorage(),
  };
  return { activity, inputs, finish, principal };
}

describe("explicit command storage adapters", () => {
  it("records directory recycle and restore at their actual provider boundaries", async () => {
    const { principal, activity, inputs, finish } = fixture();
    const moved = withMoveToTrash({
      storage: principal.storage,
      trashPath: "/.trash",
      clock: () => new Date("2026-09-14"),
      onRecycled: captureRecycleReceipt,
    });
    const provider = withRecycleFolderTrash(moved, "/.trash", "move");
    const storage = activityStorage(
      { ...principal, storage: provider },
      activity,
      () => ({ source: "mcp" }),
      "/.trash",
    );
    await storage.mkdir("/folder");
    await storage.upload("/folder/a", new Uint8Array([1]));
    await storage.deleteDir("/folder");
    expect(inputs.at(-1)?.action).toBe("file.trash");
    expect(finish).toHaveBeenLastCalledWith(
      "file.trash",
      expect.objectContaining({ kind: "dir", trashStrategy: "fdrive_move" }),
    );
    const listing = await storage.trash?.list();
    const item = listing?.entries[0];
    expect(item).toBeDefined();
    await storage.trash?.restore(item?.id ?? "", { target: "/restored" });
    expect(inputs.at(-1)?.requested).toMatchObject({ path: "/folder", targetPath: "/restored" });
    expect(finish).toHaveBeenLastCalledWith("file.restore", { path: "/restored", kind: "dir" });
    await storage.deleteFile("/restored/a");
    const next = (await storage.trash?.list())?.entries[0];
    await storage.trash?.restore(next?.id ?? "");
    expect(finish).toHaveBeenLastCalledWith("file.restore", { path: "/restored/a", kind: "file" });
  });
  it("retains acknowledged uploads when a subsequent stat is unavailable", async () => {
    const { principal, activity, finish } = fixture();
    vi.spyOn(principal.storage, "stat").mockRejectedValue(Error("offline"));
    const storage = activityStorage(principal, activity, () => ({ source: "mcp" }));
    await storage.upload("/a", new Uint8Array([1]), { modifiedAt: new Date("2026-09-14") });
    expect(finish).toHaveBeenLastCalledWith(
      "file.create",
      expect.objectContaining({ size: 1, modifiedAt: "2026-09-14T00:00:00.000Z" }),
    );
    await storage.upload(
      "/b",
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    );
    expect(finish).toHaveBeenLastCalledWith("file.create", { path: "/b", kind: "file" });
  });
  it("records actual upload/create/move/copy/delete boundaries and leaves background reads silent", async () => {
    const { principal, activity, inputs, finish } = fixture();
    const storage = activityStorage(principal, activity, () => ({
      source: "mcp",
      uploadAction: "file.upload",
      operationId: randomUUID(),
      copyVariant: "duplicate",
    }));
    await storage.mkdir("/folder");
    await storage.upload("/folder/a.txt", new Uint8Array([1, 2]), {
      modifiedAt: new Date("2026-09-14"),
    });
    await storage.copy("/folder/a.txt", "/folder/b.txt");
    await storage.move("/folder/b.txt", "/folder/c.txt");
    await storage.stat("/folder/a.txt");
    await storage.list("/folder");
    expect(inputs.map((i) => i.action)).toEqual([
      "folder.create",
      "file.upload",
      "file.copy",
      "file.move",
    ]);
    expect(inputs[2]?.requested).toMatchObject({
      path: "/folder/a.txt",
      targetPath: "/folder/b.txt",
      variant: "duplicate",
    });
    await storage.deleteFile("/folder/c.txt");
    await storage.deleteDir("/folder");
    expect(inputs.slice(-2).map((i) => i.action)).toEqual(["file.delete", "file.delete"]);
    expect(finish).toHaveBeenCalledWith(
      "file.upload",
      expect.objectContaining({ path: "/folder/a.txt", size: 2 }),
    );
  });
  it("uses the exact WebDAV receipt and accepted SFTPGo path/timestamp evidence", async () => {
    const { principal, activity, inputs, finish } = fixture();
    const moved = withMoveToTrash({
      storage: principal.storage,
      trashPath: "/.trash",
      clock: () => new Date("2026-09-14"),
      onRecycled: captureRecycleReceipt,
    });
    const storage = activityStorage(
      { ...principal, storage: moved },
      activity,
      () => ({ source: "mcp" }),
      "/.trash",
    );
    await storage.upload("/a.txt", new Uint8Array([1]));
    await storage.deleteFile("/a.txt");
    expect(inputs.at(-1)?.action).toBe("file.trash");
    expect(finish).toHaveBeenLastCalledWith(
      "file.trash",
      expect.objectContaining({
        path: "/a.txt",
        trashStrategy: "fdrive_move",
        trashLeaf: expect.stringContaining("/.trash/"),
      }),
    );
    const base = createMemoryStorage();
    await base.upload("/b.txt", new Uint8Array([1]));
    const sftp = {
      ...base,
      deleteFile: async (path: string) => {
        await base.mkdir(`/.trash${path}`, { parents: true });
        await base.move(path, `/.trash${path}/1234567890000000000`);
      },
    };
    expect(await deleteWithActivityReceipt(sftp, "/b.txt", "file", "/.trash")).toMatchObject({
      trashLeaf: "/.trash/b.txt/1234567890000000000",
      trashStrategy: "sftpgo_rule",
    });
  });
  it("keeps receipt binding unresolved on ambiguous, oversized or unreadable listings", async () => {
    const { principal } = fixture();
    const base = principal.storage;
    const entry = {
      name: "a",
      path: "/.trash/a/1234567890000000000",
      kind: "file" as const,
      size: 1,
      ext: "",
      modifiedAt: new Date(),
    };
    let calls = 0;
    for (const entries of [
      [entry, { ...entry, path: "/.trash/a/1234567890000000001" }],
      Array.from({ length: 1001 }, () => entry),
    ]) {
      calls = 0;
      const storage = {
        ...base,
        list: async () => (calls++ === 0 ? [] : entries),
        deleteFile: async () => {},
      };
      expect(await deleteWithActivityReceipt(storage, "/a", "file", "/.trash")).toEqual({
        path: "/a",
        kind: "file",
      });
    }
    expect(
      await deleteWithActivityReceipt(
        {
          ...base,
          list: async () => {
            throw Error("offline");
          },
          deleteFile: async () => {},
        },
        "/a",
        "file",
        "/.trash",
      ),
    ).toEqual({ path: "/a", kind: "file" });
    captureRecycleReceipt("/not-active", "/never-used");
  });
});

describe("transfer completion evidence", () => {
  it("still delivers bytes when the journal is unavailable and heartbeats slow downloads", async () => {
    const { activity, principal, finish } = fixture();
    vi.mocked(activity.repo.begin).mockRejectedValueOnce(Error("database offline"));
    const offline = await activityStream(
      activity,
      principal,
      "/a",
      "file.download",
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
    );
    expect(await new Response(offline).arrayBuffer()).toHaveProperty("byteLength", 3);
    expect(finish).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      const stream = await activityStream(
        activity,
        principal,
        "/a",
        "file.download",
        new ReadableStream({ pull() {} }),
      );
      vi.mocked(activity.repo.heartbeat).mockRejectedValueOnce(Error("offline"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(activity.repo.heartbeat).toHaveBeenCalledTimes(2);
      await stream.cancel();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(activity.repo.heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("waits for EOF and counts bytes, preserves failures and suppresses retry events", async () => {
    const { activity, principal, finish } = fixture();
    const source = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      });
    const stream = await activityStream(activity, principal, "/a", "file.download", source(), {
      expectedBytes: 3,
      requestId: "read-one",
    });
    expect(await new Response(stream).arrayBuffer()).toHaveProperty("byteLength", 3);
    expect(finish).toHaveBeenLastCalledWith(
      principal.accountId,
      expect.any(String),
      expect.objectContaining({ outcome: "success", after: { path: "/a", size: 3 } }),
    );
    for (const options of [{ partial: true }, { expectedBytes: 4 }]) {
      await new Response(
        await activityStream(activity, principal, "/a", "file.download", source(), options),
      ).arrayBuffer();
      expect(finish).toHaveBeenLastCalledWith(
        principal.accountId,
        expect.any(String),
        expect.objectContaining({ outcome: "partial" }),
      );
    }
    const original = source();
    expect(await activityStream(undefined, principal, "/a", "file.download", original)).toBe(
      original,
    );
    // A replayed read sends the bytes again without a second attributed event.
    vi.mocked(activity.repo.claim).mockResolvedValue(false);
    finish.mockClear();
    const replay = await activityStream(activity, principal, "/a", "file.download", source());
    expect(await new Response(replay).arrayBuffer()).toHaveProperty("byteLength", 3);
    expect(finish).not.toHaveBeenCalled();
  });
  it("delivers the whole transfer while the journal write is still in flight", async () => {
    const { activity, principal, finish } = fixture();
    let admit!: () => void;
    const held = new Promise<void>((resolve) => {
      admit = resolve;
    });
    vi.mocked(activity.repo.begin).mockImplementationOnce(async () => {
      await held;
      return { id: randomUUID() } as never;
    });
    const stream = await activityStream(
      activity,
      principal,
      "/a",
      "file.download",
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
    );
    const delivered = new Response(stream).arrayBuffer();
    admit();
    expect(await delivered).toHaveProperty("byteLength", 3);
    expect(finish).toHaveBeenLastCalledWith(
      principal.accountId,
      expect.any(String),
      expect.objectContaining({ outcome: "success" }),
    );
  });

  it("records cancelled hydration and stream errors without claiming a human open", async () => {
    const { activity, principal, finish } = fixture();
    const never = new ReadableStream<Uint8Array>({ pull() {} });
    const stream = await activityStream(activity, principal, "/a", "file.materialize", never);
    await stream.cancel();
    expect(finish).toHaveBeenLastCalledWith(
      principal.accountId,
      expect.any(String),
      expect.objectContaining({ outcome: "cancelled" }),
    );
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(Error("failed source"));
      },
    });
    await expect(
      new Response(
        await activityStream(activity, principal, "/a", "file.download", broken),
      ).arrayBuffer(),
    ).rejects.toThrow("failed source");
    expect(finish).toHaveBeenLastCalledWith(
      principal.accountId,
      expect.any(String),
      expect.objectContaining({ outcome: "failed" }),
    );
    finish.mockRejectedValueOnce(Error("history pending"));
    await expect(
      new Response(
        await activityStream(
          activity,
          principal,
          "/zip",
          "archive.compress",
          new ReadableStream({
            start(c) {
              c.close();
            },
          }),
        ),
      ).arrayBuffer(),
    ).resolves.toHaveProperty("byteLength", 0);
  });
});
