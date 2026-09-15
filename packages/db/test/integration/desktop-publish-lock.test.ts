import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";
import {
  createDb,
  createDesktopPublishLock,
  createPool,
  DesktopPublishBusyError,
} from "../../src/index.js";

/** Resolves once the callback has entered, exposing a handle that lets it finish. */
function hold(lock: ReturnType<typeof createDesktopPublishLock>, identityId: string) {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    const done = new Promise<void>((finish) => {
      release = finish;
    });
    void lock(identityId, async () => {
      resolve();
      await done;
    }).catch(() => undefined);
  });
  return entered.then(() => release);
}

it("serializes one identity's publications across independent pools and frees it on failure", {
  timeout: 180_000,
}, async () => {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const first = createDb(container.getConnectionUri());
  const second = createDb(container.getConnectionUri());
  const identity = randomUUID();
  const other = randomUUID();
  try {
    const a = createDesktopPublishLock(first.pool, { waitMs: 30_000, pollMs: 10 });
    const b = createDesktopPublishLock(second.pool, { waitMs: 30_000, pollMs: 10 });

    // Mutual exclusion: a second holder cannot enter until the first leaves.
    const release = await hold(a, identity);
    let entered = false;
    const waiting = b(identity, async () => {
      entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(entered).toBe(false);

    // A busy identity reports a retryable failure rather than blocking forever.
    const impatient = createDesktopPublishLock(second.pool, { waitMs: 150, pollMs: 10 });
    await expect(impatient(identity, async () => "unreachable")).rejects.toBeInstanceOf(
      DesktopPublishBusyError,
    );

    // A different identity is never blocked by a held one.
    await expect(b(other, async () => "free")).resolves.toBe("free");

    release();
    await waiting;
    expect(entered).toBe(true);

    // A throwing callback still releases the identity for the next writer.
    await expect(a(identity, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(b(identity, async () => "reacquired")).resolves.toBe("reacquired");

    // An exhausted pool is reported as busy too. Publication has not started, so
    // this is retryable in exactly the same way as losing the race for the lock;
    // without a bounded pool it would instead queue forever.
    const bounded = createPool(container.getConnectionUri(), {
      max: 1,
      connectionTimeoutMillis: 150,
    });
    try {
      const saturated = createDesktopPublishLock(bounded, { waitMs: 30_000, pollMs: 10 });
      const busy = await hold(saturated, randomUUID());
      await expect(saturated(randomUUID(), async () => "unreachable")).rejects.toBeInstanceOf(
        DesktopPublishBusyError,
      );
      busy();
    } finally {
      await bounded.end();
    }
  } finally {
    await first.close();
    await second.close();
    await container.stop();
  }
});
