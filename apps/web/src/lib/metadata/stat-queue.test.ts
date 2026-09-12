import { expect, it, vi } from "vitest";
import { createStatQueue } from "./stat-queue";

it("bounds concurrency and releases slots after failure and cancelled queued requests", async () => {
  const queue = createStatQueue(1);
  const blocked = Promise.withResolvers<string>();
  const controller = new AbortController();
  const first = queue(() => blocked.promise, new AbortController().signal);
  const work = vi.fn(async () => "cancelled work");
  const second = queue(work, controller.signal);
  const cancelled = expect(second).rejects.toThrow();
  controller.abort();
  const third = queue(async () => "last", new AbortController().signal);
  expect(work).not.toHaveBeenCalled();
  blocked.resolve("first");
  expect(await first).toBe("first");
  await cancelled;
  expect(work).not.toHaveBeenCalled();
  expect(await third).toBe("last");
  await expect(
    queue(async () => {
      throw new Error("failed");
    }, new AbortController().signal),
  ).rejects.toThrow("failed");
  expect(await queue(async () => "recovered", new AbortController().signal)).toBe("recovered");
});
