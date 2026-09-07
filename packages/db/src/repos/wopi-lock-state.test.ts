import { describe, expect, it } from "vitest";
import {
  createMemoryWopiLockRepo,
  type LockOperation,
  type LockRequest,
  transitionWopiLock,
  validateWopiLockRead,
  validateWopiLockRequest,
  WOPI_LOCK_TTL_MS,
  type WopiLockState,
} from "./wopi-lock-state.js";

const now = new Date("2026-01-01T12:00:00Z");
const time = now.getTime();
const request: LockRequest = { fileId: "file", operation: "lock", lockId: "a", now };

const states: readonly { name: string; value: WopiLockState | null; currentLock: string }[] = [
  { name: "absent", value: null, currentLock: "" },
  { name: "expired", value: { lockId: "a", expiresAt: time - 1 }, currentLock: "" },
  { name: "expiry boundary", value: { lockId: "a", expiresAt: time }, currentLock: "" },
  { name: "live matching", value: { lockId: "a", expiresAt: time + 1 }, currentLock: "a" },
  { name: "live different", value: { lockId: "b", expiresAt: time + 1 }, currentLock: "b" },
];
const operations: readonly LockOperation[] = ["lock", "refresh", "unlock", "relock"];

describe("WOPI lock transitions", () => {
  for (const state of states) {
    for (const operation of operations) {
      it(`${operation}: ${state.name}`, () => {
        const input = {
          ...request,
          operation,
          ...(operation === "relock" ? { oldLockId: "a", lockId: "new" } : {}),
        };
        const result = transitionWopiLock(state.value, input);
        const succeeds =
          state.currentLock === "a" || (operation === "lock" && state.currentLock === "");
        expect(result).toEqual(
          succeeds
            ? {
                result: { ok: true },
                state:
                  operation === "unlock"
                    ? null
                    : { lockId: input.lockId, expiresAt: time + WOPI_LOCK_TTL_MS },
              }
            : {
                result: { ok: false, currentLock: state.currentLock },
                state: state.currentLock === "" ? null : state.value,
              },
        );
      });
    }
  }

  it("can relock to the same opaque ID without changing the input", () => {
    const current = Object.freeze({ lockId: "a", expiresAt: time + 1 });
    expect(
      transitionWopiLock(current, { ...request, operation: "relock", oldLockId: "a" }).state,
    ).toEqual({ lockId: "a", expiresAt: time + WOPI_LOCK_TTL_MS });
    expect(current.expiresAt).toBe(time + 1);
  });
});

describe("validation", () => {
  it.each(["", "x".repeat(4097), "é".repeat(2049), "a\0b"])(
    "rejects invalid file ID %j",
    (fileId) => {
      expect(() => validateWopiLockRead(fileId, now)).toThrow(TypeError);
    },
  );
  it.each(["x".repeat(4096), "é".repeat(2048)])("accepts boundary file ID", (fileId) => {
    expect(() => validateWopiLockRead(fileId, now)).not.toThrow();
  });
  it.each([new Date(Number.NaN), new Date(8_640_000_000_000_000)])(
    "rejects invalid expiry time",
    (date) => {
      expect(() => validateWopiLockRead("file", date)).toThrow(TypeError);
    },
  );
  it("accepts the latest representable expiry", () => {
    expect(() =>
      validateWopiLockRead("file", new Date(8_640_000_000_000_000 - WOPI_LOCK_TTL_MS)),
    ).not.toThrow();
  });
  it.each(["", "x".repeat(1025), "é", "a\0b"])("rejects invalid lock ID %j", (lockId) => {
    expect(() => validateWopiLockRequest({ ...request, lockId })).toThrow(TypeError);
    expect(() =>
      validateWopiLockRequest({ ...request, operation: "relock", oldLockId: lockId }),
    ).toThrow(TypeError);
  });
  it.each(["x".repeat(1024), "\x01\x7f", " A "])("accepts opaque ASCII lock IDs", (lockId) => {
    expect(() => validateWopiLockRequest({ ...request, lockId })).not.toThrow();
  });
  it("requires the old ID for relock", () => {
    expect(() => validateWopiLockRequest({ ...request, operation: "relock" })).toThrow("oldLockId");
  });
  it("rejects unknown runtime operations", () => {
    expect(() =>
      validateWopiLockRequest({ ...request, operation: "invalid" as LockOperation }),
    ).toThrow("Unknown");
  });
});

describe("memory WOPI repository", () => {
  it("handles absence, conflicts, refresh, relock, and unlock without user ownership", async () => {
    const repo = createMemoryWopiLockRepo();
    expect(await repo.get("file", now)).toBeNull();
    expect(await repo.apply(request)).toEqual({ ok: true });
    expect(await repo.apply({ ...request, lockId: "b" })).toEqual({ ok: false, currentLock: "a" });
    expect(await repo.get("other", now)).toBeNull();
    const later = new Date(time + 10);
    expect(await repo.apply({ ...request, operation: "refresh", now: later })).toEqual({
      ok: true,
    });
    expect(await repo.get("file", new Date(time + WOPI_LOCK_TTL_MS))).toBe("a");
    expect(
      await repo.apply({
        ...request,
        operation: "relock",
        oldLockId: "a",
        lockId: "b",
        now: later,
      }),
    ).toEqual({ ok: true });
    expect(await repo.apply({ ...request, operation: "unlock" })).toEqual({
      ok: false,
      currentLock: "b",
    });
    expect(await repo.apply({ ...request, operation: "unlock", lockId: "b" })).toEqual({
      ok: true,
    });
    expect(await repo.get("file", now)).toBeNull();
  });
  it("expires exactly at the boundary and creates a replacement", async () => {
    const repo = createMemoryWopiLockRepo();
    await repo.apply(request);
    const expiry = new Date(time + WOPI_LOCK_TTL_MS);
    expect(await repo.get("file", new Date(expiry.getTime() - 1))).toBe("a");
    expect(await repo.get("file", expiry)).toBeNull();
    expect(await repo.apply({ ...request, operation: "refresh", now: expiry })).toEqual({
      ok: false,
      currentLock: "",
    });
    expect(await repo.apply({ ...request, lockId: "b", now: expiry })).toEqual({ ok: true });
    expect(await repo.get("file", expiry)).toBe("b");
  });
  it("isolates instances and rejects invalid inputs", async () => {
    const repo = createMemoryWopiLockRepo();
    await repo.apply(request);
    expect(await createMemoryWopiLockRepo().get("file", now)).toBeNull();
    await expect(repo.get("", now)).rejects.toThrow(TypeError);
    await expect(repo.apply({ ...request, lockId: "" })).rejects.toThrow(TypeError);
    expect(await repo.get("file", now)).toBe("a");
  });
});

describe("memory callback transactions", () => {
  it("holds same-file operations across awaits without blocking other files", async () => {
    const repo = createMemoryWopiLockRepo();
    const entered = createSignal();
    const release = createSignal();
    const order: string[] = [];
    const held = repo.withFileLock("file", async (locked) => {
      expect(await locked.get(now)).toBeNull();
      await locked.apply(request);
      entered.resolve();
      await release.promise;
      expect(await locked.get(now)).toBe("a");
      order.push("first");
      return 42;
    });
    await entered.promise;
    const next = repo.withFileLock("file", async (locked) => {
      order.push("second");
      expect(await locked.get(now)).toBe("a");
      return locked.apply({ ...request, lockId: "b" });
    });
    expect(await repo.apply({ ...request, fileId: "other" })).toEqual({ ok: true });
    expect(order).toEqual([]);
    release.resolve();
    expect(await held).toBe(42);
    expect(await next).toEqual({ ok: false, currentLock: "a" });
    expect(order).toEqual(["first", "second"]);
  });

  it("rolls back and releases a failed callback, including an absent starting row", async () => {
    const repo = createMemoryWopiLockRepo();
    await expect(
      repo.withFileLock("file", async (locked) => {
        await locked.apply(request);
        throw new Error("storage failed");
      }),
    ).rejects.toThrow("storage failed");
    expect(await repo.get("file", now)).toBeNull();
    await repo.apply(request);
    await expect(
      repo.withFileLock("file", async (locked) => {
        await locked.apply({ ...request, operation: "unlock" });
        expect(await locked.get(now)).toBeNull();
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await repo.get("file", now)).toBe("a");
    await expect(repo.withFileLock("", async () => 1)).rejects.toThrow(TypeError);
  });
});

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}
